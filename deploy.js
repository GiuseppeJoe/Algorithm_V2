const fs = require('fs');
require('dotenv').config();
const { 
    Connection, 
    Keypair, 
    LAMPORTS_PER_SOL, 
    PublicKey, 
    Transaction, 
    TransactionInstruction,
    sendAndConfirmTransaction, 
    SystemProgram, 
    SYSVAR_RENT_PUBKEY,
    ComputeBudgetProgram
} = require('@solana/web3.js');
const { 
    getAssociatedTokenAddressSync, 
    TOKEN_PROGRAM_ID, 
    ASSOCIATED_TOKEN_PROGRAM_ID 
} = require('@solana/spl-token');
const bs58 = require('bs58');

// --- CONFIGURATION ---
const RPC_ENDPOINT = "https://api.mainnet-beta.solana.com"; 
const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const MPL_TOKEN_METADATA = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

const payloadFile = process.argv[2];
let coinData = { name: "TEST", symbol: "TEST", description: "DEBUG" };
if (payloadFile) {
    try { coinData = JSON.parse(fs.readFileSync(payloadFile, 'utf8')); } 
    catch (err) { console.error("❌ CRITICAL: Failed to read payload JSON."); process.exit(1); }
}

if (!global.Blob) global.Blob = require('buffer').Blob; 
if (!global.fetch) global.fetch = require('node-fetch');
if (!global.FormData) global.FormData = require('form-data');

// --- MANUAL BORSH BYTE ENCODER ---
function encodeString(str) {
    const buffer = Buffer.from(str, 'utf8');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32LE(buffer.length, 0); 
    return Buffer.concat([lengthBuffer, buffer]);
}

async function uploadMetadata(tokenMetadata) {
    try {
        const formData = new FormData();
        formData.append("file", tokenMetadata.file);
        formData.append("name", tokenMetadata.name);
        formData.append("symbol", tokenMetadata.symbol);
        formData.append("description", tokenMetadata.description);
        formData.append("showName", "true");
        const response = await fetch("https://pump.fun/api/ipfs", { method: "POST", body: formData });
        if (!response.ok) throw new Error(response.statusText);
        return await response.json();
    } catch (error) { console.error("❌ Metadata Upload Error:", error); throw error; }
}

async function runDeployment() {
    console.log(`\n🕵️  STARTING DEPLOYMENT (ULTIMATE BARE METAL V3) FOR: $${coinData.symbol}`);

    const privateKeyString = process.env.SOLANA_PRIVATE_KEY;
    if (!privateKeyString) { console.error("❌ FAILURE: SOLANA_PRIVATE_KEY missing."); process.exit(1); }

    const connection = new Connection(RPC_ENDPOINT, 'confirmed');
    const secretKey = bs58.decode(privateKeyString);
    const keypair = Keypair.fromSecretKey(secretKey);

    console.log("🔥 INITIATING REAL TRANSACTION...");

    try {
        // 1. UPLOAD IMAGE
        console.log("📤 Uploading IPFS metadata...");
        const fileBuffer = fs.readFileSync("coin_image.png");
        const fileBlob = new Blob([fileBuffer], { type: 'image/png' });
        const metadataResponse = await uploadMetadata({
            file: fileBlob, name: coinData.name, symbol: coinData.symbol, description: coinData.description
        });
        console.log("✅ URI:", metadataResponse.metadataUri);

        const mint = Keypair.generate();
        console.log(`MINT_ADDRESS: ${mint.publicKey.toBase58()}`);
        
        // 2. DERIVE EXACTLY 13 ACCOUNTS
        const [mintAuthority] = PublicKey.findProgramAddressSync([Buffer.from("mint-authority")], PUMP_PROGRAM_ID);
        const [bondingCurve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.publicKey.toBuffer()], PUMP_PROGRAM_ID);
        const associatedBondingCurve = getAssociatedTokenAddressSync(mint.publicKey, bondingCurve, true);
        const [globalState] = PublicKey.findProgramAddressSync([Buffer.from("global")], PUMP_PROGRAM_ID);
        const [metadataPDA] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), MPL_TOKEN_METADATA.toBuffer(), mint.publicKey.toBuffer()], MPL_TOKEN_METADATA);
        const [eventAuthority] = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PUMP_PROGRAM_ID);

        // 3. BUILD INSTRUCTION DATA MANUALLY
        // ✅ SURGICAL FIX: The smart contract requires exactly 4 arguments (Name, Symbol, URI, Creator_Pubkey).
        // We are now properly passing your 32-byte wallet public key at the very end of the buffer.
        const discriminator = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]); 
        const nameBuffer = encodeString(coinData.name);
        const symbolBuffer = encodeString(coinData.symbol);
        const uriBuffer = encodeString(metadataResponse.metadataUri);
        const creatorBuffer = keypair.publicKey.toBuffer(); // The missing 32 bytes

        const data = Buffer.concat([discriminator, nameBuffer, symbolBuffer, uriBuffer, creatorBuffer]);

        // 4. DEFINE STRICT ACCOUNT KEYS
        // Removed the invalid 14th key (global_volume_accumulator). It only belongs to the Buy instruction.
        const keys = [
            { pubkey: mint.publicKey, isSigner: true, isWritable: true },
            { pubkey: mintAuthority, isSigner: false, isWritable: false },
            { pubkey: bondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: globalState, isSigner: false, isWritable: false },
            { pubkey: metadataPDA, isSigner: false, isWritable: true },
            { pubkey: keypair.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
            { pubkey: eventAuthority, isSigner: false, isWritable: false },
            { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }
        ];

        const createIx = new TransactionInstruction({
            programId: PUMP_PROGRAM_ID,
            keys: keys,
            data: data
        });

        // 5. GAS / PRIORITY FEES
        const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150000 });
        const computeLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 });

        // 6. ASSEMBLE AND SEND
        const tx = new Transaction()
            .add(priorityFeeIx)
            .add(computeLimitIx)
            .add(createIx);
        
        const latestBlockhash = await connection.getLatestBlockhash('confirmed');
        tx.recentBlockhash = latestBlockhash.blockhash;
        tx.feePayer = keypair.publicKey;

        const signature = await sendAndConfirmTransaction(
            connection, tx, [keypair, mint], 
            { skipPreflight: true, commitment: "confirmed" }
        );

        console.log("✅ SUCCESS! Transaction Signature:", signature);
        console.log(`🔗 URL: https://pump.fun/${mint.publicKey.toBase58()}`);

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