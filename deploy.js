const fs = require('fs');
require('dotenv').config();
const { Connection, Keypair } = require('@solana/web3.js');
const { Wallet, AnchorProvider } = require('@coral-xyz/anchor');
const { PumpFunSDK } = require('pumpdotfun-sdk');
const _bs58 = require('bs58');
const bs58 = _bs58.default || _bs58;

// --- CONFIGURATION ---
const RPC_ENDPOINT = "https://api.mainnet-beta.solana.com";

const payloadFile = process.argv[2];
let coinData = { name: "TEST", symbol: "TEST", description: "DEBUG" };
if (payloadFile) {
    try { coinData = JSON.parse(fs.readFileSync(payloadFile, 'utf8')); }
    catch (err) { console.error("❌ CRITICAL: Failed to read payload JSON."); process.exit(1); }
}

async function runDeployment() {
    console.log(`\n🕵️  STARTING DEPLOYMENT (SDK ENGINE) FOR: $${coinData.symbol}`);

    const privateKeyString = process.env.SOLANA_PRIVATE_KEY;
    if (!privateKeyString) { console.error("❌ FAILURE: SOLANA_PRIVATE_KEY missing."); process.exit(1); }

    const connection = new Connection(RPC_ENDPOINT, 'confirmed');
    const secretKey = bs58.decode(privateKeyString);
    const keypair = Keypair.fromSecretKey(secretKey);
    const wallet = new Wallet(keypair);
    const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });

    const sdk = new PumpFunSDK(provider);
    const mint = Keypair.generate();

    console.log(`MINT_ADDRESS: ${mint.publicKey.toBase58()}`);
    console.log("🔥 INITIATING REAL TRANSACTION VIA SDK...");

    try {
        // Read coin image
        const fileBuffer = fs.readFileSync("coin_image.png");
        const fileBlob = new Blob([fileBuffer], { type: 'image/png' });

        // Use the SDK's createAndBuy — handles IPFS upload + on-chain create
        // buyAmountSol = 0n means create only, no initial buy
        const result = await sdk.createAndBuy(
            keypair,                     // creator keypair (signer)
            mint,                        // mint keypair (signer)
            {
                name: coinData.name,
                symbol: coinData.symbol,
                description: coinData.description,
                file: fileBlob,
            },
            0n,                          // buyAmountSol (0 = no dev buy)
            500n,                        // slippageBasisPoints (5%)
            {
                unitLimit: 300000,
                unitPrice: 150000,
            },
            "confirmed",                 // commitment
            "confirmed"                  // finality
        );

        if (result.success) {
            console.log("✅ SUCCESS! Transaction Signature:", result.signature);
            console.log(`🔗 URL: https://pump.fun/${mint.publicKey.toBase58()}`);
        } else {
            console.error("❌ MINT FAILURE:", result.error);
            process.exit(1);
        }

    } catch (e) {
        console.error("❌ MINT FAILURE:", e);
        if (e.logs) {
            console.log("\n📝 TRANSACTION LOGS:");
            console.log(e.logs.join('\n'));
        }
        process.exit(1);
    }
}

runDeployment();
