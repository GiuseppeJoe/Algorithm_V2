// =============================================================
// SWEEP.JS — Recover funds from bundle wallets
//
// After a successful launch, each bundle wallet holds leftover
// SOL and purchased tokens. This script consolidates everything
// back to your main wallet.
//
// Usage:
//   node sweep.js                          # sweep bundle_wallets/latest.json
//   node sweep.js bundle_wallets/wallets_2025-02-25T07-25-17-234Z.json
//   node sweep.js --dry-run                # preview balances without sending
//   node sweep.js --tokens-only            # only sweep SPL tokens, keep SOL
//   node sweep.js --sol-only               # only sweep SOL, keep tokens
// =============================================================

const fs = require('fs');
require('dotenv').config();
const {
    Connection, Keypair, PublicKey, SystemProgram,
    TransactionMessage, VersionedTransaction,
    LAMPORTS_PER_SOL, ComputeBudgetProgram
} = require('@solana/web3.js');
const {
    getAssociatedTokenAddress,
    createAssociatedTokenAccountInstruction,
    createTransferInstruction,
    createCloseAccountInstruction,
    TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');
const _bs58 = require('bs58');
const bs58 = _bs58.default || _bs58;

// --- CONFIGURATION ---
const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
if (!RPC_ENDPOINT) {
    console.error("FAILURE: RPC_ENDPOINT not set in .env");
    process.exit(1);
}

const DRY_RUN = process.argv.includes("--dry-run");
const TOKENS_ONLY = process.argv.includes("--tokens-only");
const SOL_ONLY = process.argv.includes("--sol-only");

// Minimum SOL to leave behind for rent-exempt reserve (will be reclaimed when ATA is closed)
const MIN_BALANCE_FOR_RENT = 890880; // lamports (~0.00089 SOL, minimum for an account)
const TX_FEE = 5000; // lamports per signature

// Find wallet file from CLI args
const walletFile = process.argv.slice(2).find(a => !a.startsWith('--')) || "bundle_wallets/latest.json";

function toKeypair(walletData) {
    return Keypair.fromSecretKey(bs58.decode(walletData.secretKey));
}

// =============================================================
// QUERY TOKEN ACCOUNTS
// =============================================================

async function getTokenAccounts(connection, owner) {
    const response = await connection.getParsedTokenAccountsByOwner(owner, {
        programId: TOKEN_PROGRAM_ID,
    });

    return response.value.map(({ pubkey, account }) => {
        const info = account.data.parsed.info;
        return {
            address: pubkey,
            mint: new PublicKey(info.mint),
            amount: BigInt(info.tokenAmount.amount),
            decimals: info.tokenAmount.decimals,
            uiAmount: info.tokenAmount.uiAmount,
        };
    }).filter(t => t.amount > 0n); // only non-zero balances
}

// =============================================================
// SWEEP SOL
// =============================================================

async function sweepSol(connection, mainKeypair, walletData) {
    console.log(`\n[SOL SWEEP] Checking ${walletData.length} wallets...`);

    let totalRecovered = 0;
    let walletsSwept = 0;
    const errors = [];

    // Process wallets in batches to avoid rate limits
    const BATCH_SIZE = 5;
    for (let i = 0; i < walletData.length; i += BATCH_SIZE) {
        const batch = walletData.slice(i, i + BATCH_SIZE);

        for (const w of batch) {
            const kp = toKeypair(w);
            try {
                const balance = await connection.getBalance(kp.publicKey);
                const available = balance - TX_FEE; // need to cover the transfer tx fee

                if (available <= 0) {
                    console.log(`   Wallet ${w.index}: ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL (nothing to sweep)`);
                    continue;
                }

                console.log(`   Wallet ${w.index}: ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL -> sending ${(available / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

                if (!DRY_RUN) {
                    const { blockhash } = await connection.getLatestBlockhash('confirmed');
                    const instructions = [
                        SystemProgram.transfer({
                            fromPubkey: kp.publicKey,
                            toPubkey: mainKeypair.publicKey,
                            lamports: available,
                        }),
                    ];

                    const msg = new TransactionMessage({
                        payerKey: kp.publicKey,
                        recentBlockhash: blockhash,
                        instructions,
                    }).compileToV0Message();

                    const tx = new VersionedTransaction(msg);
                    tx.sign([kp]);
                    const sig = await connection.sendTransaction(tx, { skipPreflight: false });
                    await connection.confirmTransaction(sig, 'confirmed');
                    console.log(`     TX: ${sig}`);
                }

                totalRecovered += available;
                walletsSwept++;
            } catch (err) {
                console.error(`   Wallet ${w.index}: ERROR - ${err.message}`);
                errors.push({ wallet: w.index, error: err.message });
            }
        }
    }

    console.log(`\n   SOL sweep complete: ${(totalRecovered / LAMPORTS_PER_SOL).toFixed(6)} SOL from ${walletsSwept} wallets`);
    if (errors.length > 0) {
        console.log(`   ${errors.length} wallet(s) had errors (see above)`);
    }
    return totalRecovered;
}

// =============================================================
// SWEEP TOKENS
// =============================================================

async function sweepTokens(connection, mainKeypair, walletData) {
    console.log(`\n[TOKEN SWEEP] Checking ${walletData.length} wallets for token holdings...`);

    const tokenSummary = {}; // mint -> total amount
    let walletsWithTokens = 0;
    let atasClosedCount = 0;
    const errors = [];

    for (const w of walletData) {
        const kp = toKeypair(w);
        try {
            const tokenAccounts = await getTokenAccounts(connection, kp.publicKey);

            if (tokenAccounts.length === 0) continue;

            walletsWithTokens++;
            console.log(`   Wallet ${w.index}: ${tokenAccounts.length} token(s)`);

            for (const token of tokenAccounts) {
                const mintStr = token.mint.toBase58();
                if (!tokenSummary[mintStr]) {
                    tokenSummary[mintStr] = { total: 0n, decimals: token.decimals, wallets: 0 };
                }
                tokenSummary[mintStr].total += token.amount;
                tokenSummary[mintStr].wallets++;

                console.log(`     ${mintStr.slice(0, 8)}... : ${token.uiAmount} tokens`);

                if (!DRY_RUN) {
                    // Ensure main wallet has an ATA for this mint
                    const mainAta = await getAssociatedTokenAddress(token.mint, mainKeypair.publicKey, false);
                    const sourceAta = token.address;

                    const { blockhash } = await connection.getLatestBlockhash('confirmed');
                    const instructions = [];

                    // Check if main wallet ATA exists
                    const mainAtaInfo = await connection.getAccountInfo(mainAta);
                    if (!mainAtaInfo) {
                        instructions.push(
                            createAssociatedTokenAccountInstruction(
                                kp.publicKey, mainAta, mainKeypair.publicKey, token.mint
                            )
                        );
                    }

                    // Transfer tokens to main wallet
                    instructions.push(
                        createTransferInstruction(
                            sourceAta, mainAta, kp.publicKey, token.amount
                        )
                    );

                    // Close the now-empty ATA to reclaim rent SOL
                    instructions.push(
                        createCloseAccountInstruction(
                            sourceAta, kp.publicKey, kp.publicKey
                        )
                    );

                    const msg = new TransactionMessage({
                        payerKey: kp.publicKey,
                        recentBlockhash: blockhash,
                        instructions,
                    }).compileToV0Message();

                    const tx = new VersionedTransaction(msg);
                    tx.sign([kp]);
                    const sig = await connection.sendTransaction(tx, { skipPreflight: false });
                    await connection.confirmTransaction(sig, 'confirmed');
                    console.log(`     TX: ${sig}`);
                    atasClosedCount++;
                }
            }
        } catch (err) {
            console.error(`   Wallet ${w.index}: ERROR - ${err.message}`);
            errors.push({ wallet: w.index, error: err.message });
        }
    }

    // Print summary
    const mints = Object.keys(tokenSummary);
    if (mints.length > 0) {
        console.log(`\n   Token summary:`);
        for (const mint of mints) {
            const info = tokenSummary[mint];
            const uiAmount = Number(info.total) / Math.pow(10, info.decimals);
            console.log(`     ${mint.slice(0, 12)}... : ${uiAmount} tokens (from ${info.wallets} wallets)`);
        }
        if (!DRY_RUN) {
            console.log(`   Closed ${atasClosedCount} token account(s) (rent reclaimed)`);
        }
    } else {
        console.log(`   No tokens found in any wallet.`);
    }

    if (errors.length > 0) {
        console.log(`   ${errors.length} wallet(s) had errors (see above)`);
    }

    return { mints: mints.length, walletsWithTokens };
}

// =============================================================
// MAIN
// =============================================================

async function main() {
    console.log(`\n========================================`);
    console.log(`  SWEEP: Recover funds from bundle wallets`);
    console.log(`  File:  ${walletFile}`);
    if (DRY_RUN) console.log(`  MODE:  DRY RUN (preview only)`);
    if (TOKENS_ONLY) console.log(`  SCOPE: Tokens only`);
    if (SOL_ONLY) console.log(`  SCOPE: SOL only`);
    console.log(`========================================`);

    // Load main wallet
    const privateKeyString = process.env.SOLANA_PRIVATE_KEY;
    if (!privateKeyString) { console.error("FAILURE: SOLANA_PRIVATE_KEY missing."); process.exit(1); }

    const connection = new Connection(RPC_ENDPOINT, 'confirmed');
    const mainKeypair = Keypair.fromSecretKey(bs58.decode(privateKeyString));
    console.log(`   Main wallet: ${mainKeypair.publicKey.toBase58()}`);

    // Load bundle wallets
    if (!fs.existsSync(walletFile)) {
        console.error(`FAILURE: Wallet file not found: ${walletFile}`);
        console.error(`Available wallet files:`);
        const dir = walletFile.includes('/') ? walletFile.split('/').slice(0, -1).join('/') : 'bundle_wallets';
        if (fs.existsSync(dir)) {
            fs.readdirSync(dir).filter(f => f.endsWith('.json')).forEach(f => console.error(`  ${dir}/${f}`));
        }
        process.exit(1);
    }

    const walletData = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
    console.log(`   Bundle wallets: ${walletData.length}`);

    // Check main wallet balance
    const mainBalance = await connection.getBalance(mainKeypair.publicKey);
    console.log(`   Main wallet balance: ${(mainBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

    let totalSolRecovered = 0;

    // Phase 1: Sweep tokens first (they need SOL in the wallet for tx fees)
    if (!SOL_ONLY) {
        await sweepTokens(connection, mainKeypair, walletData);
    }

    // Phase 2: Sweep remaining SOL (after tokens are moved and ATAs closed)
    if (!TOKENS_ONLY) {
        totalSolRecovered = await sweepSol(connection, mainKeypair, walletData);
    }

    // Final summary
    const newBalance = DRY_RUN ? mainBalance : await connection.getBalance(mainKeypair.publicKey);
    console.log(`\n========================================`);
    console.log(`  SWEEP COMPLETE${DRY_RUN ? ' (DRY RUN)' : ''}`);
    console.log(`  SOL recovered:    ${(totalSolRecovered / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    console.log(`  Main wallet now:  ${(newBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    console.log(`========================================\n`);
}

main().catch(err => {
    console.error("FATAL ERROR:", err.message || err);
    process.exit(1);
});
