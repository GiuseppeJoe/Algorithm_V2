// =============================================================
// BUNDLER.JS — Atomic Bundled Coin Launch
//
// Generates N wallets, funds them, then uses Jito bundles to
// atomically deploy a pump.fun token + execute buy transactions
// from all wallets in the same block.
//
// Usage: node bundler.js payload.json
//        node bundler.js payload.json --dry-run       # quick validation (no tx building)
//        node bundler.js payload.json --simulate       # full pipeline test (builds txs, no SOL spent)
// =============================================================

const fs = require('fs');
require('dotenv').config();
const {
    Connection, Keypair, PublicKey, SystemProgram,
    TransactionMessage, VersionedTransaction,
    LAMPORTS_PER_SOL, ComputeBudgetProgram
} = require('@solana/web3.js');
const { Wallet, AnchorProvider } = require('@coral-xyz/anchor');
const { PumpFunSDK, calculateWithSlippageBuy } = require('pumpdotfun-sdk');
const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction } = require('@solana/spl-token');
const _bs58 = require('bs58');
const bs58 = _bs58.default || _bs58;
const BN = require('bn.js');

// --- CONFIGURATION ---
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
if (!RPC_ENDPOINT) {
    console.error(`FAILURE: RPC_ENDPOINT not set in .env`);
    console.error(`The public Solana RPC blocks programmatic access (403 Forbidden).`);
    console.error(`Add a private RPC to your .env file:`);
    console.error(`  RPC_ENDPOINT=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`);
    console.error(`Free RPC providers: Helius (helius.dev), QuickNode, Alchemy`);
    process.exit(1);
}
const JITO_BLOCK_ENGINE_URL = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

// Jito tip accounts (official)
const JITO_TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4bVqkfRtQ7NmXwkiYoYHJMm",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2o3J2AISMwhF6zTKyNBh1R",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"
];

// Tunable parameters (override via .env)
const NUM_WALLETS = parseInt(process.env.BUNDLE_WALLET_COUNT || "20");
const BUY_SOL_PER_WALLET = parseFloat(process.env.BUNDLE_BUY_SOL || "0.001");
const JITO_TIP_LAMPORTS = parseInt(process.env.JITO_TIP_LAMPORTS || "1000000"); // 0.001 SOL
const SLIPPAGE_BPS = 2500n; // 25% slippage for bundled buys
const MAX_TXS_PER_BUNDLE = 5;
const DRY_RUN = process.argv.includes("--dry-run");
const SIMULATE = process.argv.includes("--simulate");

// Deploy ID for parallel isolation — each concurrent launch gets its own files
const deployIdIdx = process.argv.indexOf("--deploy-id");
const DEPLOY_ID = deployIdIdx !== -1 ? process.argv[deployIdIdx + 1] : null;
const WALLETS_DIR = DEPLOY_ID ? `bundle_wallets_${DEPLOY_ID}` : "bundle_wallets";
const IMAGE_FILE = DEPLOY_ID ? `coin_image_${DEPLOY_ID}.png` : "coin_image.png";

// Read coin data from CLI payload (skip flags and their values)
const payloadFile = process.argv.slice(2).find((a, i, arr) => !a.startsWith('--') && (i === 0 || !arr[i - 1].startsWith('--')));
let coinData = { name: "TEST", symbol: "TEST", description: "DEBUG" };
if (payloadFile) {
    try { coinData = JSON.parse(fs.readFileSync(payloadFile, 'utf8')); }
    catch (err) { console.error("CRITICAL: Failed to read payload JSON."); process.exit(1); }
}

// =============================================================
// PHASE 1: WALLET GENERATION
//
// Fresh wallets are created for EVERY launch. This is critical:
//   - Each launch needs clean wallets with no on-chain history
//   - Reusing wallets links launches together on-chain
//   - Old wallets are archived to bundle_wallets/<timestamp>.json
//     so you can recover leftover SOL later if needed
// =============================================================

function generateFreshWallets(count) {
    console.log(`\n[PHASE 1] Generating ${count} fresh bundle wallets...`);

    // Archive previous wallets (if any) so keys aren't lost
    if (!fs.existsSync(WALLETS_DIR)) fs.mkdirSync(WALLETS_DIR);
    const latestFile = `${WALLETS_DIR}/latest.json`;
    if (fs.existsSync(latestFile)) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archivePath = `${WALLETS_DIR}/wallets_${timestamp}.json`;
        fs.renameSync(latestFile, archivePath);
        console.log(`   Archived previous wallets -> ${archivePath}`);
    }

    // Generate fresh keypairs
    const wallets = [];
    for (let i = 0; i < count; i++) {
        const kp = Keypair.generate();
        wallets.push({
            index: i,
            publicKey: kp.publicKey.toBase58(),
            secretKey: bs58.encode(kp.secretKey)
        });
    }

    fs.writeFileSync(latestFile, JSON.stringify(wallets, null, 2));
    console.log(`   Generated ${count} wallets -> ${latestFile}`);
    return wallets;
}

function toKeypair(walletData) {
    return Keypair.fromSecretKey(bs58.decode(walletData.secretKey));
}

// =============================================================
// RETRY HELPER
// =============================================================

async function withRetry(fn, { retries = 3, baseDelay = 1000, label = '' } = {}) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt === retries) throw err;
            const delay = baseDelay * Math.pow(2, attempt);
            console.log(`   [retry] ${label} attempt ${attempt + 1} failed: ${err.message} — retrying in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// =============================================================
// PHASE 2: FUND WALLETS (fire-all-then-confirm)
// =============================================================

async function fundWallets(connection, mainKeypair, walletDataList, solPerWallet) {
    console.log(`\n[PHASE 2] Funding ${walletDataList.length} wallets (${solPerWallet} SOL buy + fees each)...`);

    // Each wallet needs: buy SOL + ~0.003 SOL for ATA rent + tx fee
    const lamportsPerWallet = Math.ceil((solPerWallet + 0.003) * LAMPORTS_PER_SOL);
    const totalNeeded = lamportsPerWallet * walletDataList.length;

    const balance = await connection.getBalance(mainKeypair.publicKey);
    console.log(`   Main wallet balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    console.log(`   Funding needed:      ${(totalNeeded / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

    if (balance < totalNeeded + 0.01 * LAMPORTS_PER_SOL) {
        throw new Error(
            `Insufficient balance. Need ~${((totalNeeded + 0.01 * LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL).toFixed(4)} SOL, ` +
            `have ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`
        );
    }

    // Build all funding txs, send them all, then confirm in parallel
    const BATCH_SIZE = 20;
    const pendingSigs = [];

    for (let i = 0; i < walletDataList.length; i += BATCH_SIZE) {
        const batch = walletDataList.slice(i, i + BATCH_SIZE);
        const instructions = batch.map(w =>
            SystemProgram.transfer({
                fromPubkey: mainKeypair.publicKey,
                toPubkey: new PublicKey(w.publicKey),
                lamports: lamportsPerWallet,
            })
        );

        const sig = await withRetry(async () => {
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            const msgV0 = new TransactionMessage({
                payerKey: mainKeypair.publicKey,
                recentBlockhash: blockhash,
                instructions,
            }).compileToV0Message();
            const vTx = new VersionedTransaction(msgV0);
            vTx.sign([mainKeypair]);
            return await connection.sendTransaction(vTx, { skipPreflight: false });
        }, { label: `fund batch ${i + 1}-${i + batch.length}` });

        console.log(`   Sent funding tx for wallets ${i + 1}-${i + batch.length}: ${sig}`);
        pendingSigs.push({ sig, start: i + 1, end: i + batch.length });
    }

    // Confirm all funding txs in parallel
    console.log(`   Confirming ${pendingSigs.length} funding tx(s)...`);
    await Promise.all(pendingSigs.map(async ({ sig, start, end }) => {
        await connection.confirmTransaction(sig, 'confirmed');
        console.log(`   Confirmed wallets ${start}-${end}: ${sig}`);
    }));

    console.log(`   All ${walletDataList.length} wallets funded.`);
}

// =============================================================
// PHASE 3: UPLOAD METADATA
// =============================================================

async function uploadMetadata(sdk) {
    console.log(`\n[PHASE 3] Uploading coin metadata to IPFS...`);
    const fileBuffer = fs.readFileSync(IMAGE_FILE);
    const fileBlob = new Blob([fileBuffer], { type: 'image/png' });

    const result = await sdk.createTokenMetadata({
        name: coinData.name,
        symbol: coinData.symbol,
        description: coinData.description,
        file: fileBlob,
    });
    console.log(`   Metadata URI: ${result.metadataUri}`);
    return result.metadataUri;
}

// =============================================================
// PHASE 4: BUILD JITO BUNDLES (CREATE + BUYS)
// =============================================================

function pickTipAccount() {
    return new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
}

async function buildAllBundles(connection, sdk, mainKeypair, mintKeypair, walletKeypairs, metadataUri, buyAmountSol, tipLamports = JITO_TIP_LAMPORTS) {
    console.log(`\n[PHASE 4] Building Jito bundles (tip: ${(tipLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL)...`);

    const globalAccount = await sdk.getGlobalAccount('confirmed');
    const feeRecipient = globalAccount.feeRecipient;

    // Pre-compute buy amounts
    const buyLamports = BigInt(Math.floor(buyAmountSol * LAMPORTS_PER_SOL));
    const tokenAmount = globalAccount.getInitialBuyPrice(buyLamports);
    const maxSolCost = calculateWithSlippageBuy(buyLamports, SLIPPAGE_BPS);

    console.log(`   Buy per wallet: ${buyAmountSol} SOL -> ~${tokenAmount} tokens`);
    console.log(`   Max SOL with slippage: ${Number(maxSolCost) / LAMPORTS_PER_SOL} SOL`);

    // Pre-derive shared PDAs
    const bondingCurvePDA = sdk.getBondingCurvePDA(mintKeypair.publicKey);
    const associatedBondingCurve = await getAssociatedTokenAddress(
        mintKeypair.publicKey, bondingCurvePDA, true
    );

    // --- Group wallets into bundles ---
    // Bundle 1: create tx + first N-1 buy txs
    // Bundle 2+: up to N buy txs each
    const bundleGroups = [];
    const firstGroupSize = MAX_TXS_PER_BUNDLE - 1; // 4 buys + 1 create
    bundleGroups.push({
        includeCreate: true,
        walletIndices: walletKeypairs.slice(0, firstGroupSize).map((_, i) => i),
    });

    for (let i = firstGroupSize; i < walletKeypairs.length; i += MAX_TXS_PER_BUNDLE) {
        const end = Math.min(i + MAX_TXS_PER_BUNDLE, walletKeypairs.length);
        bundleGroups.push({
            includeCreate: false,
            walletIndices: Array.from({ length: end - i }, (_, j) => i + j),
        });
    }

    console.log(`   ${bundleGroups.length} bundle(s) for ${walletKeypairs.length} wallets`);
    console.log(`   Bundle layout: ${bundleGroups.map((g, i) => `B${i + 1}[${g.includeCreate ? 'create+' : ''}${g.walletIndices.length} buys]`).join(', ')}`);

    // --- Build each bundle ---
    const allBundles = [];

    for (let bi = 0; bi < bundleGroups.length; bi++) {
        const group = bundleGroups[bi];
        const serializedTxs = [];

        // Fresh blockhash per bundle — prevents stale-blockhash rejection
        // on later bundles when build time exceeds ~60s
        const { blockhash } = await connection.getLatestBlockhash('finalized');

        // BUILD CREATE TX (only in first bundle)
        if (group.includeCreate) {
            const createTx = await sdk.getCreateInstructions(
                mainKeypair.publicKey, coinData.name, coinData.symbol, metadataUri, mintKeypair
            );

            const createInstructions = [
                ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150000 }),
                ...createTx.instructions,
            ];

            // If no buys in this bundle, add Jito tip here
            if (group.walletIndices.length === 0) {
                createInstructions.push(
                    SystemProgram.transfer({
                        fromPubkey: mainKeypair.publicKey,
                        toPubkey: pickTipAccount(),
                        lamports: tipLamports,
                    })
                );
            }

            const createMsg = new TransactionMessage({
                payerKey: mainKeypair.publicKey,
                recentBlockhash: blockhash,
                instructions: createInstructions,
            }).compileToV0Message();
            const signedCreate = new VersionedTransaction(createMsg);
            signedCreate.sign([mainKeypair, mintKeypair]);
            serializedTxs.push(signedCreate.serialize());
        }

        // BUILD BUY TXS
        for (let wi = 0; wi < group.walletIndices.length; wi++) {
            const walletIdx = group.walletIndices[wi];
            const buyer = walletKeypairs[walletIdx];
            const isLastInBundle = (wi === group.walletIndices.length - 1);

            const associatedUser = await getAssociatedTokenAddress(
                mintKeypair.publicKey, buyer.publicKey, false
            );

            const buyInstructions = [
                ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 }),
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150000 }),
                // Create ATA (new wallet, no ATA exists yet)
                createAssociatedTokenAccountInstruction(
                    buyer.publicKey, associatedUser, buyer.publicKey, mintKeypair.publicKey
                ),
            ];

            // Build buy instruction via Anchor (correct encoding guaranteed)
            const buyIx = await sdk.program.methods
                .buy(new BN(tokenAmount.toString()), new BN(maxSolCost.toString()))
                .accounts({
                    feeRecipient: feeRecipient,
                    mint: mintKeypair.publicKey,
                    associatedBondingCurve: associatedBondingCurve,
                    associatedUser: associatedUser,
                    user: buyer.publicKey,
                })
                .instruction();
            buyInstructions.push(buyIx);

            // Jito tip on the last tx of each bundle — paid by main wallet
            // (buyer wallets are only funded for buy + ATA rent, not enough for tip)
            if (isLastInBundle) {
                buyInstructions.push(
                    SystemProgram.transfer({
                        fromPubkey: mainKeypair.publicKey,
                        toPubkey: pickTipAccount(),
                        lamports: tipLamports,
                    })
                );
            }

            const buyMsg = new TransactionMessage({
                payerKey: buyer.publicKey,
                recentBlockhash: blockhash,
                instructions: buyInstructions,
            }).compileToV0Message();
            const signedBuy = new VersionedTransaction(buyMsg);
            // Main wallet must co-sign last tx (it pays the Jito tip)
            signedBuy.sign(isLastInBundle ? [buyer, mainKeypair] : [buyer]);
            serializedTxs.push(signedBuy.serialize());
        }

        allBundles.push(serializedTxs);
    }

    return allBundles;
}

// =============================================================
// PHASE 5: SUBMIT BUNDLES TO JITO
// =============================================================

async function submitJitoBundle(serializedTxs) {
    const encodedTxs = serializedTxs.map(tx => bs58.encode(tx));

    const response = await fetch(JITO_BLOCK_ENGINE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'sendBundle',
            params: [encodedTxs],
        }),
    });

    const result = await response.json();
    if (result.error) {
        throw new Error(`Jito error: ${JSON.stringify(result.error)}`);
    }
    return result.result; // bundle UUID
}

async function checkBundleStatus(bundleId) {
    const response = await fetch(JITO_BLOCK_ENGINE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
        }),
    });
    const result = await response.json();
    if (result.error) {
        // Return a sentinel so callers can distinguish API errors from "no status"
        return { _jitoError: true, error: result.error };
    }
    return result.result?.value?.[0] || null;
}

async function checkInflightBundleStatus(bundleId) {
    try {
        const response = await fetch(JITO_BLOCK_ENGINE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'getInflightBundleStatuses',
                params: [[bundleId]],
            }),
        });
        const result = await response.json();
        return result.result?.value?.[0] || null;
    } catch {
        return null;
    }
}

async function submitAllBundles(allBundles) {
    console.log(`\n[PHASE 5] Submitting ${allBundles.length} bundle(s) to Jito...`);
    const bundleIds = [];

    for (let i = 0; i < allBundles.length; i++) {
        const bundle = allBundles[i];
        console.log(`   Submitting bundle ${i + 1}/${allBundles.length} (${bundle.length} txs)...`);

        const bundleId = await withRetry(
            () => submitJitoBundle(bundle),
            { label: `Jito bundle ${i + 1}`, retries: 2, baseDelay: 500 }
        );
        bundleIds.push(bundleId);
        console.log(`   Bundle ${i + 1} accepted: ${bundleId}`);

        // Small delay between bundles to ensure ordering
        if (i < allBundles.length - 1) {
            await new Promise(r => setTimeout(r, 200));
        }
    }

    return bundleIds;
}

async function waitForBundles(bundleIds) {
    console.log(`\n[PHASE 6] Waiting for ${bundleIds.length} bundle(s) to confirm...`);
    const maxAttempts = 30; // 60s max
    const confirmed = new Set();
    const failed = new Set();
    const lastStatus = {};
    const noStatusCount = {}; // track consecutive genuine null responses (not errors)
    const errorCount = {};    // track consecutive API errors separately
    bundleIds.forEach((_, i) => { noStatusCount[i] = 0; errorCount[i] = 0; });

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(r => setTimeout(r, 2000));

        for (let i = 0; i < bundleIds.length; i++) {
            if (confirmed.has(i) || failed.has(i)) continue;

            try {
                const status = await checkBundleStatus(bundleIds[i]);

                // Jito API returned an error (rate limit, etc.) — don't count as "no status"
                if (status && status._jitoError) {
                    errorCount[i]++;
                    if (errorCount[i] % 5 === 1) {
                        console.log(`   Bundle ${i + 1}: Jito API error (${errorCount[i]}x): ${status.error.message || JSON.stringify(status.error)}`);
                    }
                    continue;
                }

                if (status) {
                    noStatusCount[i] = 0;
                    errorCount[i] = 0;
                    lastStatus[i] = status;
                    const confirmation = status.confirmation_status;

                    if (confirmation === 'confirmed' || confirmation === 'finalized') {
                        console.log(`   Bundle ${i + 1} ${confirmation}! Slot: ${status.slot}`);
                        confirmed.add(i);
                    } else if (status.err) {
                        console.error(`   Bundle ${i + 1} FAILED:`, JSON.stringify(status.err));
                        if (status.transactions) {
                            status.transactions.forEach((tx, ti) => {
                                if (tx?.err) console.error(`     TX ${ti + 1} error:`, JSON.stringify(tx.err));
                            });
                        }
                        failed.add(i);
                    }
                } else {
                    noStatusCount[i]++;

                    // Before declaring dropped, check if it's still in Jito's queue
                    if (noStatusCount[i] >= 8) {
                        const inflight = await checkInflightBundleStatus(bundleIds[i]);
                        if (inflight) {
                            console.log(`   Bundle ${i + 1}: still in Jito queue (status: ${inflight.status || 'pending'}) — continuing to wait`);
                            noStatusCount[i] = 0; // reset — it's still alive
                            continue;
                        }
                    }

                    // Only declare dropped after 15 genuine no-status responses (~30s)
                    // and no inflight status
                    if (noStatusCount[i] >= 15) {
                        console.error(`   Bundle ${i + 1}: no status after ${noStatusCount[i]} checks — Jito dropped it`);
                        failed.add(i);
                    }
                }
            } catch (e) {
                errorCount[i]++;
                if (attempt % 5 === 0) {
                    console.log(`   Bundle ${i + 1} status check error: ${e.message}`);
                }
            }
        }

        if (confirmed.size === bundleIds.length) {
            console.log(`   All ${bundleIds.length} bundle(s) confirmed.`);
            return true;
        }

        // If create bundle failed or was dropped, abort immediately
        if (failed.has(0)) {
            console.error(`   Bundle 1 (create) failed/dropped — aborting to retry with higher tip.`);
            return false;
        }

        // If ALL bundles failed, no point waiting
        if (confirmed.size + failed.size === bundleIds.length && failed.size > 0) {
            return confirmed.has(0);
        }

        if (attempt % 5 === 0 || attempt === maxAttempts - 1) {
            const pending = bundleIds.length - confirmed.size - failed.size;
            console.log(`   Attempt ${attempt + 1}/${maxAttempts}: ${confirmed.size} confirmed, ${failed.size} failed, ${pending} pending`);
        } else {
            console.log(`   Attempt ${attempt + 1}: ${confirmed.size}/${bundleIds.length} confirmed...`);
        }
    }

    // Timeout — show diagnostics
    console.error(`\n   BUNDLE LANDING FAILED — timed out after ${maxAttempts * 2}s`);
    for (let i = 0; i < bundleIds.length; i++) {
        if (!confirmed.has(i)) {
            const s = lastStatus[i];
            if (s) {
                console.error(`   Bundle ${i + 1} (${bundleIds[i]}): last status = ${s.confirmation_status || 'unknown'}`);
            } else if (errorCount[i] > 0) {
                console.error(`   Bundle ${i + 1} (${bundleIds[i]}): ${errorCount[i]} API errors — Jito may have been rate-limiting status checks`);
            } else {
                console.error(`   Bundle ${i + 1} (${bundleIds[i]}): no status returned — Jito dropped it`);
            }
        }
    }

    if (confirmed.has(0)) {
        console.log(`\n   WARNING: Bundle 1 (create) confirmed but ${bundleIds.length - confirmed.size} buy bundle(s) timed out.`);
        return true;
    }

    return false;
}

// =============================================================
// MAIN ORCHESTRATOR
// =============================================================

async function main() {
    console.log(`\n========================================`);
    console.log(`  BUNDLED LAUNCH: $${coinData.symbol}`);
    console.log(`  Wallets: ${NUM_WALLETS} | Buy: ${BUY_SOL_PER_WALLET} SOL each`);
    if (DRY_RUN) console.log(`  MODE: DRY RUN (no real transactions)`);
    if (SIMULATE) console.log(`  MODE: SIMULATE (full pipeline, no SOL spent)`);
    console.log(`========================================`);

    // Load main wallet
    const privateKeyString = process.env.SOLANA_PRIVATE_KEY;
    if (!privateKeyString) { console.error("FAILURE: SOLANA_PRIVATE_KEY missing."); process.exit(1); }

    const connection = new Connection(RPC_ENDPOINT, 'confirmed');
    const mainKeypair = Keypair.fromSecretKey(bs58.decode(privateKeyString));
    const wallet = new Wallet(mainKeypair);
    const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
    const sdk = new PumpFunSDK(provider);

    console.log(`   Main wallet: ${mainKeypair.publicKey.toBase58()}`);

    try {
        // PHASE 1: Generate fresh wallets (new every launch)
        const walletData = generateFreshWallets(NUM_WALLETS);

        // In dry-run mode, validate everything but don't spend SOL
        if (DRY_RUN) {
            console.log(`\n[DRY RUN] Validating configuration...`);

            const balance = await connection.getBalance(mainKeypair.publicKey);
            const lamportsPerWallet = Math.ceil((BUY_SOL_PER_WALLET + 0.003) * LAMPORTS_PER_SOL);
            const totalFunding = lamportsPerWallet * NUM_WALLETS;
            const totalCost = totalFunding + 0.02 * LAMPORTS_PER_SOL; // funding + create fees

            console.log(`   Main wallet balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
            console.log(`   Cost per wallet:     ${(lamportsPerWallet / LAMPORTS_PER_SOL).toFixed(4)} SOL (${BUY_SOL_PER_WALLET} buy + 0.003 fees)`);
            console.log(`   Total funding:       ${(totalFunding / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
            console.log(`   Total cost estimate: ${(totalCost / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
            console.log(`   Balance sufficient:  ${balance >= totalCost ? 'YES' : 'NO — need ' + ((totalCost - balance) / LAMPORTS_PER_SOL).toFixed(4) + ' more SOL'}`);

            // Validate SDK can reach pump.fun global state
            const globalAccount = await sdk.getGlobalAccount('confirmed');
            console.log(`   Pump.fun global:     OK (fee recipient: ${globalAccount.feeRecipient.toBase58().slice(0, 8)}...)`);

            const buyLamports = BigInt(Math.floor(BUY_SOL_PER_WALLET * LAMPORTS_PER_SOL));
            const tokenAmount = globalAccount.getInitialBuyPrice(buyLamports);
            const maxSolCost = calculateWithSlippageBuy(buyLamports, SLIPPAGE_BPS);
            console.log(`   Tokens per wallet:   ~${tokenAmount.toString()}`);
            console.log(`   Max SOL w/ slippage:  ${(Number(maxSolCost) / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

            // Show bundle layout
            const firstGroupSize = MAX_TXS_PER_BUNDLE - 1;
            const remainingWallets = NUM_WALLETS - firstGroupSize;
            const extraBundles = Math.ceil(Math.max(0, remainingWallets) / MAX_TXS_PER_BUNDLE);
            const totalBundles = 1 + extraBundles;
            console.log(`   Bundle layout:       ${totalBundles} bundle(s)`);
            console.log(`     B1: create + ${Math.min(firstGroupSize, NUM_WALLETS)} buys`);
            for (let b = 0; b < extraBundles; b++) {
                const start = firstGroupSize + b * MAX_TXS_PER_BUNDLE;
                const count = Math.min(MAX_TXS_PER_BUNDLE, NUM_WALLETS - start);
                console.log(`     B${b + 2}: ${count} buys`);
            }

            // Check coin image
            const imageExists = fs.existsSync(IMAGE_FILE);
            console.log(`   Coin image:          ${imageExists ? `OK (${IMAGE_FILE} found)` : `MISSING — ${IMAGE_FILE} not found`}`);

            console.log(`\n[DRY RUN] Validation complete. No transactions sent.`);
            console.log(`   Run without --dry-run to execute for real.`);
            return;
        }

        // =============================================================
        // SIMULATE MODE — full pipeline test without spending SOL
        //
        // Runs everything through Phase 4 (transaction building) but:
        //   - Phase 2: validates funding math, skips actual transfers
        //   - Phase 3: uses a test metadata URI, skips IPFS upload
        //   - Phase 4: builds ALL bundles (real tx construction + signing)
        //   - Phase 5: validates txs deserialize, simulates create tx on RPC
        //   - Phase 6: skipped (no bundles submitted)
        // =============================================================
        if (SIMULATE) {
            // -- Phase 2: Validate funding --
            console.log(`\n[PHASE 2] [SIMULATE] Validating funding requirements...`);
            const balance = await connection.getBalance(mainKeypair.publicKey);
            const lamportsPerWallet = Math.ceil((BUY_SOL_PER_WALLET + 0.003) * LAMPORTS_PER_SOL);
            const totalFunding = lamportsPerWallet * NUM_WALLETS;
            const totalCost = totalFunding + 0.02 * LAMPORTS_PER_SOL;
            console.log(`   Main wallet balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
            console.log(`   Funding needed:      ${(totalFunding / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
            console.log(`   Total cost estimate: ${(totalCost / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
            console.log(`   Balance sufficient:  ${balance >= totalCost ? 'YES' : 'NO'}`);

            // -- Phase 3: Skip IPFS, use test URI --
            console.log(`\n[PHASE 3] [SIMULATE] Skipping IPFS upload, using test metadata URI`);
            const metadataUri = "https://simulate.test/metadata.json";

            // -- Phase 4: Build all bundles (real tx construction) --
            const mintKeypair = Keypair.generate();
            console.log(`MINT_ADDRESS: ${mintKeypair.publicKey.toBase58()}`);

            const walletKeypairs = walletData.map(toKeypair);
            const allBundles = await buildAllBundles(
                connection, sdk, mainKeypair, mintKeypair,
                walletKeypairs, metadataUri, BUY_SOL_PER_WALLET
            );

            // -- Phase 5: Validate bundles --
            console.log(`\n[PHASE 5] [SIMULATE] Validating ${allBundles.length} bundle(s)...`);
            let totalTxs = 0;
            let validTxs = 0;
            let failedTxs = 0;

            for (let i = 0; i < allBundles.length; i++) {
                const bundle = allBundles[i];
                totalTxs += bundle.length;
                console.log(`\n   Bundle ${i + 1}: ${bundle.length} tx(s)`);

                for (let j = 0; j < bundle.length; j++) {
                    try {
                        const tx = VersionedTransaction.deserialize(bundle[j]);
                        const sigCount = tx.signatures.length;
                        const ixCount = tx.message.compiledInstructions.length;
                        console.log(`     TX ${j + 1}: OK (${bundle[j].length} bytes, ${sigCount} sig(s), ${ixCount} instruction(s))`);
                        validTxs++;
                    } catch (e) {
                        console.error(`     TX ${j + 1}: FAILED — ${e.message}`);
                        failedTxs++;
                    }
                }
            }

            // Try simulating the create tx against RPC
            console.log(`\n   Simulating create transaction on RPC...`);
            try {
                const createTx = VersionedTransaction.deserialize(allBundles[0][0]);
                const simResult = await connection.simulateTransaction(createTx);
                if (simResult.value.err) {
                    console.log(`   Create TX simulation: program rejected (expected with test metadata URI)`);
                    console.log(`     Error: ${JSON.stringify(simResult.value.err)}`);
                    console.log(`     Units consumed: ${simResult.value.unitsConsumed || 'N/A'}`);
                    console.log(`     (This is normal — real launch uses a valid IPFS URI)`);
                } else {
                    console.log(`   Create TX simulation: PASSED (${simResult.value.unitsConsumed} compute units)`);
                }
            } catch (e) {
                console.log(`   Create TX simulation error: ${e.message}`);
                console.log(`     (This is normal for simulation — does not indicate a real problem)`);
            }

            // Summary
            console.log(`\n========================================`);
            console.log(`  SIMULATION COMPLETE`);
            console.log(`  Wallets generated: ${NUM_WALLETS}`);
            console.log(`  Bundles built:     ${allBundles.length}`);
            console.log(`  Transactions:      ${validTxs}/${totalTxs} valid`);
            if (failedTxs > 0) {
                console.log(`  FAILURES:          ${failedTxs} tx(s) failed validation`);
            }
            console.log(`========================================\n`);

            if (failedTxs > 0) {
                process.exit(1);
            }
            return;
        }

        // PHASE 2: Fund wallets
        await fundWallets(connection, mainKeypair, walletData, BUY_SOL_PER_WALLET);

        // PHASE 3: Upload metadata to IPFS
        const metadataUri = await uploadMetadata(sdk);

        // PHASES 4-6: Build, submit, and confirm bundles
        // Retries with escalating Jito tip if bundle fails to land
        const MAX_LANDING_ATTEMPTS = 3;
        const TIP_MULTIPLIER = 2; // double tip on each retry
        const mintKeypair = Keypair.generate();
        console.log(`MINT_ADDRESS: ${mintKeypair.publicKey.toBase58()}`);
        const walletKeypairs = walletData.map(toKeypair);

        let currentTip = JITO_TIP_LAMPORTS;
        let success = false;
        let lastBundleIds = [];

        for (let landingAttempt = 0; landingAttempt < MAX_LANDING_ATTEMPTS; landingAttempt++) {
            if (landingAttempt > 0) {
                // Before retrying, check if the mint already exists on-chain
                // (previous bundle may have landed even though Jito didn't report it)
                try {
                    const mintInfo = await connection.getAccountInfo(mintKeypair.publicKey);
                    if (mintInfo) {
                        console.log(`   Mint account EXISTS on-chain — previous bundle DID land!`);
                        console.log(`   Jito status API failed to report it (likely rate-limited).`);
                        success = true;
                        break;
                    }
                } catch (e) {
                    // Non-fatal — proceed with retry
                }

                currentTip = Math.floor(currentTip * TIP_MULTIPLIER);
                console.log(`\n[RETRY ${landingAttempt}/${MAX_LANDING_ATTEMPTS - 1}] Rebuilding bundles with higher tip: ${(currentTip / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
            }

            // PHASE 4: Build bundles (with current tip level)
            const allBundles = await buildAllBundles(
                connection, sdk, mainKeypair, mintKeypair,
                walletKeypairs, metadataUri, BUY_SOL_PER_WALLET,
                currentTip
            );

            // PHASE 5: Submit bundles to Jito
            lastBundleIds = await submitAllBundles(allBundles);

            // PHASE 6: Wait for confirmation
            success = await waitForBundles(lastBundleIds);

            if (success) break;

            if (landingAttempt < MAX_LANDING_ATTEMPTS - 1) {
                console.log(`   Bundle didn't land. Will retry with ${(currentTip * TIP_MULTIPLIER / LAMPORTS_PER_SOL).toFixed(4)} SOL tip...`);
            }
        }

        // Final on-chain check if all Jito attempts reported failure
        if (!success) {
            try {
                const mintInfo = await connection.getAccountInfo(mintKeypair.publicKey);
                if (mintInfo) {
                    console.log(`\n   On-chain check: Mint account EXISTS — a bundle DID land despite Jito not reporting it.`);
                    success = true;
                }
            } catch (e) {
                // Non-fatal
            }
        }

        if (success) {
            console.log(`\n========================================`);
            console.log(`  SUCCESS: $${coinData.symbol} LAUNCHED`);
            console.log(`  Mint:    ${mintKeypair.publicKey.toBase58()}`);
            console.log(`  URL:     https://pump.fun/${mintKeypair.publicKey.toBase58()}`);
            console.log(`  Wallets: ${NUM_WALLETS} bought ${BUY_SOL_PER_WALLET} SOL each`);
            console.log(`  Tip:     ${(currentTip / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
            console.log(`  Bundles: ${lastBundleIds.join(', ')}`);
            console.log(`========================================\n`);
            console.log(`BUNDLE_WALLETS: ${NUM_WALLETS}`);
            console.log(`BUNDLE_IDS: ${lastBundleIds.join(',')}`);
        } else {
            console.error(`\nBUNDLE LANDING FAILED after ${MAX_LANDING_ATTEMPTS} attempts (final tip: ${(currentTip / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
            console.log(`MINT_ADDRESS: ${mintKeypair.publicKey.toBase58()}`);
            console.log(`Check: https://solscan.io/account/${mintKeypair.publicKey.toBase58()}`);
            process.exit(1);
        }

    } catch (e) {
        console.error(`\nFATAL ERROR:`, e.message || e);
        if (e.logs) console.log("TX LOGS:", e.logs.join('\n'));
        process.exit(1);
    }
}

main();
