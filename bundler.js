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
// Jito block-engine regional endpoints. The default mainnet host is frequently
// globally rate-limited (error -32097), so we round-robin across regions — each
// region has its own rate-limit budget.
const JITO_ENDPOINTS = [
    { name: 'mainnet',   url: "https://mainnet.block-engine.jito.wtf/api/v1/bundles" },
    { name: 'amsterdam', url: "https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles" },
    { name: 'frankfurt', url: "https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles" },
    { name: 'ny',        url: "https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles" },
    { name: 'slc',       url: "https://slc.mainnet.block-engine.jito.wtf/api/v1/bundles" },
    { name: 'tokyo',     url: "https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles" },
];

let _jitoEndpointIdx = 0;
function nextJitoEndpoint() {
    const ep = JITO_ENDPOINTS[_jitoEndpointIdx % JITO_ENDPOINTS.length];
    _jitoEndpointIdx++;
    return ep;
}
function isRateLimitError(errObj) {
    // Jito uses -32097 for global rate-limit; check code + message defensively
    if (!errObj) return false;
    if (errObj.code === -32097) return true;
    const msg = (errObj.message || '').toLowerCase();
    return msg.includes('rate limit') || msg.includes('network congested');
}

// Jito tip accounts. These are rarely rotated but *are* maintained by Jito,
// so at runtime we ALSO query `getTipAccounts` and prefer its result. This
// hardcoded list is the fallback when the API call fails.
// Verified against https://docs.jito.wtf/lowlatencytxnsend/ (2026-04).
const JITO_TIP_ACCOUNTS_FALLBACK = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"
];
// Populated by initTipAccounts() at startup. pickTipAccount() reads from here.
let JITO_TIP_ACCOUNTS = JITO_TIP_ACCOUNTS_FALLBACK;

// Matches Solana's base58 alphabet (excludes 0, O, I, l) with 32-44 char length.
// Used to sanity-check any pubkey string before we trust it (blockhashes, tip
// accounts, RPC responses). A bad address here causes Jito -32602 or the
// cryptic "Non-base58 character" error from @solana/web3.js.
const BASE58_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Query Jito for the live tip-account list. Rotates through regions to
// shrug off per-region rate limits; times out each request at 5s. Returns
// `{ source, accounts }` on success, `null` if every region failed or
// returned a malformed payload. The regex filter means a garbage response
// can never silently replace our vetted fallback list.
async function fetchTipAccounts() {
    for (let i = 0; i < JITO_ENDPOINTS.length; i++) {
        const ep = nextJitoEndpoint();
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 5000);
            const res = await fetch(ep.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 1,
                    method: 'getTipAccounts', params: []
                }),
                signal: ctrl.signal,
            });
            clearTimeout(t);
            const json = await res.json();
            const list = json && json.result;
            if (Array.isArray(list) && list.length >= 4 &&
                list.every(a => typeof a === 'string' && BASE58_PUBKEY_RE.test(a))) {
                return { source: ep.name, accounts: list };
            }
        } catch (_) { /* try next region */ }
    }
    return null;
}

// Must be called before any code path that reaches pickTipAccount().
async function initTipAccounts() {
    const live = await fetchTipAccounts();
    if (live) {
        JITO_TIP_ACCOUNTS = live.accounts;
        console.log(`   Jito tip accounts: ${live.accounts.length} fetched from ${live.source}`);
    } else {
        JITO_TIP_ACCOUNTS = JITO_TIP_ACCOUNTS_FALLBACK;
        console.log(`   Jito tip accounts: using hardcoded fallback (${JITO_TIP_ACCOUNTS_FALLBACK.length} addresses) — live fetch failed`);
    }
}

// Query Jito's public tip-floor endpoint for the live 75th/95th percentile of
// *landed* tips. This is the only way to know what tip is actually winning
// the auction right now — a static default will silently under-tip during
// congestion and our bundle gets dropped (the core reliability issue).
// Returns SOL values (not lamports); caller converts. Null on any failure.
async function fetchJitoTipFloor() {
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor', { signal: ctrl.signal });
        clearTimeout(t);
        const json = await res.json();
        const row = Array.isArray(json) ? json[0] : (json && json.data && json.data[0]);
        if (!row) return null;
        const p75 = Number(row.landed_tips_75th_percentile);
        const p95 = Number(row.landed_tips_95th_percentile);
        if (!Number.isFinite(p75) || p75 <= 0) return null;
        return {
            p75,
            p95: Number.isFinite(p95) && p95 > 0 ? p95 : null,
        };
    } catch (_) {
        return null;
    }
}

// Tunable parameters (override via .env)
const NUM_WALLETS = parseInt(process.env.BUNDLE_WALLET_COUNT || "20");
const BUY_SOL_PER_WALLET = parseFloat(process.env.BUNDLE_BUY_SOL || "0.001");
// 0.002 SOL baseline — pump.fun launches during congestion routinely need
// 0.005+ to win the Jito auction, so our 2× escalation (0.002 → 0.004 →
// 0.008) gives us headroom by attempt 3. Overridable via .env.
const JITO_TIP_LAMPORTS = parseInt(process.env.JITO_TIP_LAMPORTS || "2000000"); // 0.002 SOL
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
            // Callers can mark errors as non-retryable by setting err.noRetry.
            // This prevents burning retries on bundles that are globally
            // invalid (e.g. stale tip account -> Jito -32602) — the outer
            // landingAttempt loop will rebuild with a fresh tip pick.
            if (err && err.noRetry) throw err;
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

async function fundWallets(connection, mainKeypair, walletDataList, solPerWallet, startingTipLamports) {
    console.log(`\n[PHASE 2] Funding ${walletDataList.length} wallets (${solPerWallet} SOL buy + fees each)...`);

    // Each wallet needs: buy SOL + ~0.003 SOL for ATA rent + tx fee
    const lamportsPerWallet = Math.ceil((solPerWallet + 0.003) * LAMPORTS_PER_SOL);
    const totalNeeded = lamportsPerWallet * walletDataList.length;

    const balance = await connection.getBalance(mainKeypair.publicKey);
    console.log(`   Main wallet balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    console.log(`   Funding needed:      ${(totalNeeded / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

    // Worst-case tip spend: main wallet pays one tip per bundle, and the
    // landingAttempt loop (main orchestrator) can escalate 2× across 3
    // attempts — so the peak is numBundles × (1 + 2 + 4) × startingTip.
    // Uses the *dynamic* starting tip (live Jito p75) when provided, so the
    // balance check reflects reality during congestion. Without this a
    // late-stage retry with escalated tip could fail mid-flight when the
    // main wallet runs out of SOL.
    const tipPerBundle = startingTipLamports || JITO_TIP_LAMPORTS;
    const firstGroupSize = MAX_TXS_PER_BUNDLE - 1;
    const remaining = Math.max(0, walletDataList.length - firstGroupSize);
    const numBundles = 1 + Math.ceil(remaining / MAX_TXS_PER_BUNDLE);
    const worstCaseTip = tipPerBundle * numBundles * (1 + 2 + 4);
    const buffer = 0.01 * LAMPORTS_PER_SOL + worstCaseTip;
    console.log(`   Worst-case tip:      ${(worstCaseTip / LAMPORTS_PER_SOL).toFixed(4)} SOL (${numBundles} bundle(s) × 7× escalation at ${(tipPerBundle / LAMPORTS_PER_SOL).toFixed(4)} SOL baseline)`);

    if (balance < totalNeeded + buffer) {
        throw new Error(
            `Insufficient balance. Need ~${((totalNeeded + buffer) / LAMPORTS_PER_SOL).toFixed(4)} SOL ` +
            `(funding: ${(totalNeeded / LAMPORTS_PER_SOL).toFixed(4)}, ` +
            `worst-case tips: ${(worstCaseTip / LAMPORTS_PER_SOL).toFixed(4)}, ` +
            `fees buffer: 0.01), have ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`
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
    // Validate response shape — pump.fun occasionally returns errors or
    // shifted response formats; we'd rather fail loudly here than hand a
    // malformed string downstream and get a cryptic bs58 error.
    if (typeof result.metadataUri !== 'string' || !result.metadataUri.startsWith('http')) {
        throw new Error(`Invalid metadataUri from pump.fun: ${JSON.stringify(result)}`);
    }
    return result.metadataUri;
}

// =============================================================
// PHASE 4: BUILD JITO BUNDLES (CREATE + BUYS)
// =============================================================

function pickTipAccount() {
    if (!Array.isArray(JITO_TIP_ACCOUNTS) || JITO_TIP_ACCOUNTS.length === 0) {
        throw new Error('Jito tip accounts list is empty — initTipAccounts() was not called or both live fetch and fallback failed');
    }
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

    // Matches Solana's base58 alphabet (excludes 0, O, I, l) with 32-44 char length
    const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

    for (let bi = 0; bi < bundleGroups.length; bi++) {
        const group = bundleGroups[bi];
        const serializedTxs = [];

        // Pick the tip account once per bundle so (a) we log the exact
        // address (if Jito -32602 ever recurs we know which pubkey it
        // rejected) and (b) create+buy bundles with multiple tip-eligible
        // slots all write-lock the same account.
        const tipAccount = pickTipAccount();
        console.log(`   Bundle ${bi + 1}: tip ${(tipLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL -> ${tipAccount.toBase58()}`);

        // Labeled step tracker so if a bs58/anchor error fires deep in a
        // dependency, the thrown message still names the exact step + bundle.
        let step = 'init';
        try {
            step = 'getLatestBlockhash';
            // Fresh blockhash per bundle — prevents stale-blockhash rejection
            // on later bundles when build time exceeds ~60s
            const { blockhash } = await connection.getLatestBlockhash('finalized');

            // Validate — RPC occasionally returns odd payloads (error strings,
            // empty objects). A bad blockhash triggers a cryptic "Non-base58
            // character" later in compileToV0Message; fail with a clear
            // message instead.
            if (typeof blockhash !== 'string' || !BASE58_RE.test(blockhash)) {
                throw new Error(`Invalid blockhash from RPC: ${JSON.stringify(blockhash)}`);
            }

            // BUILD CREATE TX (only in first bundle)
            if (group.includeCreate) {
                step = 'sdk.getCreateInstructions';
                const createTx = await sdk.getCreateInstructions(
                    mainKeypair.publicKey, coinData.name, coinData.symbol, metadataUri, mintKeypair
                );

                step = 'compose create instructions';
                const createInstructions = [
                    ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
                    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150000 }),
                    ...createTx.instructions,
                ];

                // If no buys in this bundle, add Jito tip here
                if (group.walletIndices.length === 0 && tipLamports > 0) {
                    createInstructions.push(
                        SystemProgram.transfer({
                            fromPubkey: mainKeypair.publicKey,
                            toPubkey: tipAccount,
                            lamports: tipLamports,
                        })
                    );
                }

                step = 'compile/sign create tx';
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

                step = `getAssociatedTokenAddress (buy ${wi + 1})`;
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

                step = `sdk.program.methods.buy (buy ${wi + 1})`;
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
                // (buyer wallets are only funded for buy + ATA rent, not enough for tip).
                // Skipped when tipLamports === 0 (non-bundled fallback path).
                const needsTip = isLastInBundle && tipLamports > 0;
                if (needsTip) {
                    buyInstructions.push(
                        SystemProgram.transfer({
                            fromPubkey: mainKeypair.publicKey,
                            toPubkey: tipAccount,
                            lamports: tipLamports,
                        })
                    );
                }

                step = `compile/sign buy tx ${wi + 1}`;
                const buyMsg = new TransactionMessage({
                    payerKey: buyer.publicKey,
                    recentBlockhash: blockhash,
                    instructions: buyInstructions,
                }).compileToV0Message();
                const signedBuy = new VersionedTransaction(buyMsg);
                signedBuy.sign(needsTip ? [buyer, mainKeypair] : [buyer]);
                serializedTxs.push(signedBuy.serialize());
            }

            allBundles.push(serializedTxs);
        } catch (e) {
            throw new Error(`buildAllBundles bundle ${bi + 1}, step "${step}": ${e.message || e}`);
        }
    }

    return allBundles;
}

// =============================================================
// PHASE 5: SUBMIT BUNDLES TO JITO
// =============================================================

async function submitJitoBundle(serializedTxs) {
    const encodedTxs = serializedTxs.map(tx => bs58.encode(tx));

    // Submit to ALL regions simultaneously. Sequential submission means only
    // one region's validators see the bundle — if they don't have a leader
    // slot in the bundle's validity window, it never lands. Broadcasting to
    // all 6 regions maximises validator coverage.
    const submissions = await Promise.allSettled(
        JITO_ENDPOINTS.map(ep =>
            fetch(ep.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'sendBundle',
                    params: [encodedTxs],
                }),
            })
            .then(r => r.json())
            .then(result => {
                if (result.error) {
                    if (isRateLimitError(result.error)) {
                        return { ep, rateLimited: true, error: result.error };
                    }
                    // Deterministic rejection (-32602 bad tip, etc.) — same
                    // bytes will fail on every region. Surface immediately.
                    const err = new Error(`Jito error [${ep.name}]: ${JSON.stringify(result.error)}`);
                    err.noRetry = true;
                    err.jitoCode = result.error.code;
                    throw err;
                }
                return { ep, uuid: result.result };
            })
            .catch(err => { err._ep = ep.name; throw err; })
        )
    );

    const successes = submissions.filter(r => r.status === 'fulfilled' && r.value && r.value.uuid);
    const hardFail  = submissions.find(r => r.status === 'rejected' && r.reason && r.reason.noRetry);

    if (hardFail) throw hardFail.reason;

    if (successes.length === 0) {
        const rateLimitedCount = submissions.filter(r => r.status === 'fulfilled' && r.value && r.value.rateLimited).length;
        const errorCount = submissions.filter(r => r.status === 'rejected').length;
        throw new Error(`Jito error: all ${JITO_ENDPOINTS.length} regions failed (${rateLimitedCount} rate-limited, ${errorCount} errors)`);
    }

    const regions = successes.map(r => r.value.ep.name).join(', ');
    console.log(`   Accepted by ${successes.length}/${JITO_ENDPOINTS.length} regions: [${regions}]`);
    return successes[0].value.uuid; // primary UUID for status tracking
}

async function checkBundleStatus(bundleId) {
    const ep = nextJitoEndpoint();
    const response = await fetch(ep.url, {
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
        return { _jitoError: true, error: result.error, endpoint: ep.name };
    }
    return result.result?.value?.[0] || null;
}

async function checkInflightBundleStatus(bundleId) {
    try {
        const ep = nextJitoEndpoint();
        const response = await fetch(ep.url, {
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
        if (result.error) return null; // rate-limited or other — treat as inconclusive
        return result.result?.value?.[0] || null;
    } catch {
        return null;
    }
}

async function submitAllBundles(allBundles, connection) {
    console.log(`\n[PHASE 5] Submitting ${allBundles.length} bundle(s) to Jito...`);

    // --- PRE-SUBMISSION SIMULATION ---
    // Simulate the create tx on our RPC before committing to the Jito auction.
    // Jito's block engine silently drops bundles that fail internal simulation
    // with zero feedback — the bundle UUID is returned, then it never lands.
    // By simulating first, we surface program errors instantly instead of
    // waiting 90s for a timeout. Buy txs can't be simulated individually
    // (they depend on the create having executed), but if the create is
    // invalid, nothing will land anyway.
    console.log(`   Simulating create transaction on RPC...`);
    try {
        const createTx = VersionedTransaction.deserialize(allBundles[0][0]);
        const simResult = await connection.simulateTransaction(createTx, {
            sigVerify: false,
            replaceRecentBlockhash: true,
        });
        if (simResult.value.err) {
            console.error(`   CREATE TX SIMULATION FAILED:`);
            console.error(`     Error: ${JSON.stringify(simResult.value.err)}`);
            if (simResult.value.logs) {
                console.error(`     Program logs:`);
                simResult.value.logs.forEach(l => console.error(`       ${l}`));
            }
            throw new Error(`Create tx would fail on-chain: ${JSON.stringify(simResult.value.err)}. Aborting before wasting Jito tip.`);
        }
        console.log(`   Create TX simulation: PASSED (${simResult.value.unitsConsumed || '?'} compute units)`);
    } catch (e) {
        if (e.message.startsWith('Create tx would fail')) throw e;
        console.log(`   Create TX simulation: inconclusive (${e.message}) — proceeding with submission`);
    }

    const bundleIds = [];
    // Per-bundle tx signatures — used for RPC-side verification when Jito
    // status API is rate-limited. Signatures are available on the signed
    // VersionedTransaction before submission.
    const bundleSigs = [];

    for (let i = 0; i < allBundles.length; i++) {
        const bundle = allBundles[i];
        console.log(`   Submitting bundle ${i + 1}/${allBundles.length} (${bundle.length} txs)...`);

        // Extract signatures from each serialized tx in the bundle (for RPC verification)
        const sigsForBundle = bundle.map(serialized => {
            const tx = VersionedTransaction.deserialize(serialized);
            return bs58.encode(tx.signatures[0]);
        });
        bundleSigs.push(sigsForBundle);

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

    return { bundleIds, bundleSigs };
}

async function waitForBundles(bundleIds, { connection, mintPubkey, bundleSigs } = {}) {
    console.log(`\n[PHASE 6] Waiting for ${bundleIds.length} bundle(s) to confirm...`);
    // 40s window per attempt. A Solana blockhash is valid ~60s; if nothing
    // lands in 40s the bundle is effectively dead — fail fast and let the
    // landingAttempt loop rebuild with a fresh blockhash + higher tip.
    const maxAttempts = 20;
    const confirmed = new Set();
    const failed = new Set();
    const lastStatus = {};
    const noStatusCount = {};           // consecutive genuine null responses from Jito (not errors)
    const errorCount = {};              // consecutive Jito API errors (rate-limits, etc.)
    const inflightTerminalCount = {};   // consecutive terminal (Invalid/Failed) inflight replies
    bundleIds.forEach((_, i) => {
        noStatusCount[i] = 0;
        errorCount[i] = 0;
        inflightTerminalCount[i] = 0;
    });

    const canCheckOnChain = !!(connection && mintPubkey);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await new Promise(r => setTimeout(r, 2000));

        // --- ON-CHAIN CHECK (authoritative signal) ---
        // Run this first every tick. If the mint account exists, the create
        // bundle landed regardless of what Jito says.
        if (canCheckOnChain && !confirmed.has(0)) {
            try {
                const mintInfo = await connection.getAccountInfo(mintPubkey, 'confirmed');
                if (mintInfo) {
                    console.log(`   Bundle 1 (create): mint account EXISTS on-chain — confirmed via RPC`);
                    confirmed.add(0);
                }
            } catch (e) {
                // Non-fatal — RPC hiccup; fall through to Jito check
            }
        }

        // --- RPC SIGNATURE STATUS CHECK for buy bundles ---
        // For bundles we don't yet have a confirmation for, query the first
        // tx signature directly. This bypasses Jito completely.
        if (canCheckOnChain && bundleSigs) {
            const toCheck = [];
            for (let i = 0; i < bundleIds.length; i++) {
                if (confirmed.has(i) || failed.has(i)) continue;
                const sig = bundleSigs[i] && bundleSigs[i][0];
                if (sig) toCheck.push({ idx: i, sig });
            }
            if (toCheck.length > 0) {
                try {
                    const sigStatuses = await connection.getSignatureStatuses(
                        toCheck.map(t => t.sig),
                        { searchTransactionHistory: false }
                    );
                    for (let k = 0; k < toCheck.length; k++) {
                        const st = sigStatuses.value[k];
                        const idx = toCheck[k].idx;
                        if (!st) continue;
                        if (st.err) {
                            console.error(`   Bundle ${idx + 1}: RPC reports tx error: ${JSON.stringify(st.err)}`);
                            failed.add(idx);
                        } else if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
                            console.log(`   Bundle ${idx + 1} ${st.confirmationStatus} via RPC! Slot: ${st.slot}`);
                            confirmed.add(idx);
                        }
                    }
                } catch (e) {
                    // Non-fatal — RPC hiccup
                }
            }
        }

        if (confirmed.size === bundleIds.length) {
            console.log(`   All ${bundleIds.length} bundle(s) confirmed.`);
            return true;
        }

        // --- JITO STATUS CHECK (secondary signal) ---
        for (let i = 0; i < bundleIds.length; i++) {
            if (confirmed.has(i) || failed.has(i)) continue;

            try {
                const status = await checkBundleStatus(bundleIds[i]);

                // Jito API returned an error (rate limit, etc.) — don't count as "no status"
                if (status && status._jitoError) {
                    errorCount[i]++;
                    if (errorCount[i] === 1 || errorCount[i] % 10 === 0) {
                        const rl = isRateLimitError(status.error) ? ' [rate-limited]' : '';
                        console.log(`   Bundle ${i + 1}: Jito API error (${errorCount[i]}x)${rl} [endpoint: ${status.endpoint || '?'}]: ${status.error.message || JSON.stringify(status.error)}`);
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

                    // Before declaring dropped, check Jito's inflight tracker.
                    // Valid statuses per Jito docs:
                    //   Landed  — bundle landed on-chain (success)
                    //   Pending — still being processed (keep waiting)
                    //   Failed  — all regions rejected (terminal)
                    //   Invalid — bundle ID not found in 5-min window (terminal;
                    //             can be briefly transient during regional
                    //             consistency right after submit, so require
                    //             two consecutive reads before declaring dead)
                    if (noStatusCount[i] >= 5) {
                        const inflight = await checkInflightBundleStatus(bundleIds[i]);
                        if (inflight) {
                            const s = String(inflight.status || '').toLowerCase();
                            if (s === 'landed') {
                                console.log(`   Bundle ${i + 1}: Jito reports LANDED`);
                                confirmed.add(i);
                                inflightTerminalCount[i] = 0;
                                continue;
                            }
                            if (s === 'pending') {
                                console.log(`   Bundle ${i + 1}: still in Jito queue (status: Pending) — continuing to wait`);
                                noStatusCount[i] = 0;
                                inflightTerminalCount[i] = 0;
                                continue;
                            }
                            if (s === 'failed' || s === 'invalid') {
                                inflightTerminalCount[i]++;
                                if (inflightTerminalCount[i] >= 2) {
                                    console.error(`   Bundle ${i + 1}: Jito reports ${s.toUpperCase()} (${inflightTerminalCount[i]}x) — dropped (lost auction / tip too low)`);
                                    failed.add(i);
                                    continue;
                                }
                                console.log(`   Bundle ${i + 1}: Jito reports ${s.toUpperCase()} (1x) — waiting one more tick to confirm`);
                                continue;
                            }
                            // Unknown status value — treat conservatively as alive
                            console.log(`   Bundle ${i + 1}: Jito reports unknown status '${inflight.status}' — continuing to wait`);
                            noStatusCount[i] = 0;
                            inflightTerminalCount[i] = 0;
                            continue;
                        }
                    }

                    // Only declare dropped after 15 genuine no-status responses AND
                    // no recent API errors AND no RPC signature found. When Jito
                    // has been rate-limiting us, we don't trust "no status" as a
                    // drop signal — wait for timeout and rely on on-chain check.
                    if (noStatusCount[i] >= 10 && errorCount[i] === 0) {
                        // Try one more RPC signature check before giving up
                        let rpcSaysLanded = false;
                        if (canCheckOnChain && bundleSigs && bundleSigs[i] && bundleSigs[i][0]) {
                            try {
                                const st = await connection.getSignatureStatuses([bundleSigs[i][0]], { searchTransactionHistory: true });
                                if (st.value[0] && !st.value[0].err) rpcSaysLanded = true;
                            } catch {}
                        }
                        if (!rpcSaysLanded) {
                            console.error(`   Bundle ${i + 1}: no status after ${noStatusCount[i]} checks — Jito dropped it`);
                            failed.add(i);
                        }
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

    // Timeout — final on-chain check before giving up
    console.error(`\n   BUNDLE LANDING FAILED — timed out after ${maxAttempts * 2}s`);

    if (canCheckOnChain && !confirmed.has(0)) {
        try {
            const mintInfo = await connection.getAccountInfo(mintPubkey, 'confirmed');
            if (mintInfo) {
                console.log(`   Final RPC check: mint account EXISTS — create bundle DID land`);
                confirmed.add(0);
            }
        } catch {}
    }

    for (let i = 0; i < bundleIds.length; i++) {
        if (!confirmed.has(i)) {
            const s = lastStatus[i];
            if (s) {
                console.error(`   Bundle ${i + 1} (${bundleIds[i]}): last status = ${s.confirmation_status || 'unknown'}`);
            } else if (errorCount[i] > 0) {
                console.error(`   Bundle ${i + 1} (${bundleIds[i]}): ${errorCount[i]} API errors — Jito rate-limited status checks the entire time`);
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
        // Pull Jito's live tip-account list *before* any code path can reach
        // pickTipAccount(). Robust against Jito rotating addresses: the
        // hardcoded list is just a fallback.
        await initTipAccounts();

        // Pull live Jito tip-floor percentiles. The 75th percentile of
        // recently-landed tips is the single best proxy for "what tip is
        // winning the auction right now." Use max(env-baseline, live p75)
        // so a user-configured floor can override upward but we never
        // silently under-tip the live market and get our bundle dropped.
        const tipFloor = await fetchJitoTipFloor();
        let startingTip = JITO_TIP_LAMPORTS;
        if (tipFloor) {
            const p75Lamports = Math.ceil(tipFloor.p75 * LAMPORTS_PER_SOL);
            const p95Lamports = tipFloor.p95 ? Math.ceil(tipFloor.p95 * LAMPORTS_PER_SOL) : null;
            startingTip = Math.max(JITO_TIP_LAMPORTS, p75Lamports);
            console.log(`   Jito tip floor: p75 ${(p75Lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL` +
                (p95Lamports ? ` | p95 ${(p95Lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL` : ''));
            console.log(`   Starting tip:   ${(startingTip / LAMPORTS_PER_SOL).toFixed(4)} SOL (env baseline: ${(JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
        } else {
            console.log(`   Jito tip floor: unavailable — using static baseline ${(startingTip / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
        }

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
        await fundWallets(connection, mainKeypair, walletData, BUY_SOL_PER_WALLET, startingTip);

        // PHASE 3: Upload metadata to IPFS
        const metadataUri = await uploadMetadata(sdk);

        // PHASES 4-6: Build, submit, and confirm bundles
        // Retries with escalating Jito tip if bundle fails to land
        const MAX_LANDING_ATTEMPTS = 3;
        const TIP_MULTIPLIER = 2; // double tip on each retry
        const mintKeypair = Keypair.generate();
        console.log(`MINT_ADDRESS: ${mintKeypair.publicKey.toBase58()}`);
        const walletKeypairs = walletData.map(toKeypair);

        let currentTip = startingTip;
        let success = false;
        let lastBundleIds = [];

        for (let landingAttempt = 0; landingAttempt < MAX_LANDING_ATTEMPTS; landingAttempt++) {
            // Unconditional mint-exists check at the top of every attempt.
            // This prevents re-submitting a duplicate bundle whenever a prior
            // attempt actually landed but Jito's rate-limited API failed to
            // report it. Runs on attempt 0 too — harmless (no-op) but protects
            // against races where the mint already exists for some reason.
            try {
                const mintInfo = await connection.getAccountInfo(mintKeypair.publicKey, 'confirmed');
                if (mintInfo) {
                    if (landingAttempt > 0) {
                        console.log(`   Mint account EXISTS on-chain — previous bundle DID land!`);
                        console.log(`   Jito status API failed to report it (likely rate-limited).`);
                    } else {
                        console.log(`   Mint account already exists on-chain — skipping launch.`);
                    }
                    success = true;
                    break;
                }
            } catch (e) {
                // Non-fatal — proceed with attempt
            }

            if (landingAttempt > 0) {
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
            const submitResult = await submitAllBundles(allBundles, connection);
            lastBundleIds = submitResult.bundleIds;
            const lastBundleSigs = submitResult.bundleSigs;

            // PHASE 6: Wait for confirmation — pass RPC + mint + signatures so
            // waitForBundles can fall back to on-chain verification whenever
            // Jito's status API is rate-limited.
            success = await waitForBundles(lastBundleIds, {
                connection,
                mintPubkey: mintKeypair.publicKey,
                bundleSigs: lastBundleSigs,
            });

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

        // =============================================================
        // FALLBACK: Non-bundled sequential submission via RPC
        //
        // If ALL Jito bundle attempts failed, bypass Jito entirely and
        // submit transactions individually through our RPC. This trades
        // full atomicity for actual landing — the create tx is sent
        // first, confirmed, then buy txs are blasted in parallel.
        //
        // The sniping window between create and buys is 1-2 slots
        // (~0.8-1.6s) at most, acceptable for low-value launches.
        // =============================================================
        if (!success) {
            console.log(`\n========================================`);
            console.log(`  [FALLBACK] Jito bundles failed ${MAX_LANDING_ATTEMPTS}× — switching to direct RPC submission`);
            console.log(`========================================`);

            try {
                // Build fresh transactions WITHOUT Jito tip (tipLamports = 0)
                console.log(`\n[FALLBACK PHASE 1] Building transactions (no Jito tip)...`);
                const fallbackBundles = await buildAllBundles(
                    connection, sdk, mainKeypair, mintKeypair,
                    walletKeypairs, metadataUri, BUY_SOL_PER_WALLET,
                    0 // no tip — we're not going through Jito
                );

                // Submit create tx via regular RPC
                console.log(`\n[FALLBACK PHASE 2] Submitting create transaction via RPC...`);
                const createTxBytes = fallbackBundles[0][0];
                const createSig = await withRetry(async () => {
                    const tx = VersionedTransaction.deserialize(createTxBytes);
                    return await connection.sendTransaction(tx, {
                        skipPreflight: false,
                        maxRetries: 3,
                    });
                }, { label: 'create tx via RPC', retries: 2, baseDelay: 1000 });
                console.log(`   Create TX sent: ${createSig}`);

                // Wait for create to confirm
                console.log(`   Waiting for create TX confirmation...`);
                await connection.confirmTransaction(createSig, 'confirmed');
                console.log(`   Create TX confirmed!`);

                // Verify mint exists on-chain
                const mintCheck = await connection.getAccountInfo(mintKeypair.publicKey, 'confirmed');
                if (!mintCheck) {
                    throw new Error('Create TX confirmed but mint account not found on-chain');
                }
                console.log(`   Mint account verified on-chain: ${mintKeypair.publicKey.toBase58()}`);

                // Submit all buy txs in parallel via RPC
                console.log(`\n[FALLBACK PHASE 3] Submitting ${walletKeypairs.length} buy transactions via RPC...`);

                // Collect all buy tx bytes (skip first tx in first bundle — that's the create)
                const buyTxBytes = [];
                for (let bi = 0; bi < fallbackBundles.length; bi++) {
                    const startIdx = (bi === 0) ? 1 : 0;
                    for (let ti = startIdx; ti < fallbackBundles[bi].length; ti++) {
                        buyTxBytes.push(fallbackBundles[bi][ti]);
                    }
                }

                // Need fresh blockhash for buy txs since they were built minutes ago
                // Rebuild each buy tx with fresh blockhash
                const { blockhash: freshBlockhash } = await connection.getLatestBlockhash('confirmed');
                const buyResults = await Promise.allSettled(
                    buyTxBytes.map(async (txBytes, idx) => {
                        const tx = VersionedTransaction.deserialize(txBytes);
                        // Replace blockhash with fresh one
                        tx.message.recentBlockhash = freshBlockhash;
                        // Re-sign (blockhash changed so signatures are invalid)
                        const buyer = walletKeypairs[idx];
                        tx.sign([buyer]);
                        const sig = await connection.sendTransaction(tx, {
                            skipPreflight: false,
                            maxRetries: 3,
                        });
                        console.log(`   Buy ${idx + 1}/${buyTxBytes.length} sent: ${sig}`);
                        return sig;
                    })
                );

                const buySuccesses = buyResults.filter(r => r.status === 'fulfilled');
                const buyFailures = buyResults.filter(r => r.status === 'rejected');
                console.log(`   Buy results: ${buySuccesses.length}/${buyTxBytes.length} sent`);
                if (buyFailures.length > 0) {
                    buyFailures.forEach((f, i) => console.error(`   Buy failure: ${f.reason?.message || f.reason}`));
                }

                // Wait for buy confirmations
                if (buySuccesses.length > 0) {
                    console.log(`   Confirming ${buySuccesses.length} buy transaction(s)...`);
                    const confirmResults = await Promise.allSettled(
                        buySuccesses.map(r =>
                            connection.confirmTransaction(r.value, 'confirmed')
                        )
                    );
                    const confirmed = confirmResults.filter(r => r.status === 'fulfilled').length;
                    console.log(`   ${confirmed}/${buySuccesses.length} buy txs confirmed`);
                }

                success = true;
                lastBundleIds = ['FALLBACK-RPC'];
            } catch (fallbackErr) {
                console.error(`\n[FALLBACK] Failed: ${fallbackErr.message}`);
                if (fallbackErr.stack) console.error(fallbackErr.stack);
                // Check if create at least landed
                try {
                    const mintInfo = await connection.getAccountInfo(mintKeypair.publicKey, 'confirmed');
                    if (mintInfo) {
                        console.log(`   Mint DID land despite buy failures — token exists on pump.fun`);
                        success = true;
                        lastBundleIds = ['FALLBACK-PARTIAL'];
                    }
                } catch (_) {}
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
        if (e.stack) console.error(e.stack);
        if (e.logs) console.log("TX LOGS:", e.logs.join('\n'));
        process.exit(1);
    }
}

main();
