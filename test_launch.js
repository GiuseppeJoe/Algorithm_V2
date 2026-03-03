// =============================================================
// TEST_LAUNCH.JS — Test the coin launch + bundling pipeline
//
// Runs bundler.js in --simulate mode which exercises the full
// pipeline (wallet gen, funding validation, tx construction,
// bundle building) without spending any SOL.
//
// Usage:
//   node test_launch.js               # test bundled launch
//   node test_launch.js --standard    # test standard (non-bundled) deploy.js
//   node test_launch.js --both        # test both paths
// =============================================================

const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const TEST_STANDARD = process.argv.includes('--standard');
const TEST_BOTH = process.argv.includes('--both');
const TEST_BUNDLED = !TEST_STANDARD || TEST_BOTH;
const TEST_STD = TEST_STANDARD || TEST_BOTH;

// Minimal valid PNG (1x1 transparent pixel)
const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
    'Nl7BcQAAAABJRU5ErkJggg==',
    'base64'
);

function createFixtures(testId) {
    const payloadFile = `payload_${testId}.json`;
    const imageFile = `coin_image_${testId}.png`;

    fs.writeFileSync(payloadFile, JSON.stringify({
        name: "Test Coin",
        symbol: "TEST",
        description: "Automated pipeline simulation test",
    }));
    fs.writeFileSync(imageFile, PNG_1x1);

    return { payloadFile, imageFile };
}

function cleanup(testId) {
    const files = [
        `payload_${testId}.json`,
        `coin_image_${testId}.png`,
    ];
    for (const f of files) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    const walletDir = `bundle_wallets_${testId}`;
    if (fs.existsSync(walletDir)) {
        fs.rmSync(walletDir, { recursive: true });
    }
}

function runScript(script, args, successMarker) {
    return new Promise((resolve) => {
        const child = spawn('node', [script, ...args], {
            stdio: ['inherit', 'pipe', 'pipe'],
            cwd: __dirname,
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
            const text = data.toString();
            stdout += text;
            // Indent child output for clarity
            text.split('\n').forEach(line => {
                if (line.trim()) process.stdout.write(`   | ${line}\n`);
            });
        });

        child.stderr.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            text.split('\n').forEach(line => {
                if (line.trim()) process.stderr.write(`   | ${line}\n`);
            });
        });

        child.on('close', (code) => {
            resolve({
                code,
                stdout,
                stderr,
                passed: code === 0 && stdout.includes(successMarker),
            });
        });
    });
}

async function testBundledLaunch() {
    const testId = `sim_${crypto.randomBytes(4).toString('hex')}`;
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  TEST: Bundled Launch (bundler.js --simulate)`);
    console.log(`  Deploy ID: ${testId}`);
    console.log(`${'='.repeat(50)}\n`);

    const { payloadFile } = createFixtures(testId);

    try {
        const result = await runScript('bundler.js', [
            payloadFile, '--simulate', '--deploy-id', testId,
        ], 'SIMULATION COMPLETE');

        console.log('');
        if (result.passed) {
            console.log(`  BUNDLED LAUNCH TEST: PASSED`);
        } else {
            console.log(`  BUNDLED LAUNCH TEST: FAILED (exit code: ${result.code})`);
        }
        return result.passed;
    } finally {
        cleanup(testId);
    }
}

async function testStandardLaunch() {
    const testId = `sim_${crypto.randomBytes(4).toString('hex')}`;
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  TEST: Standard Launch (deploy.js validation)`);
    console.log(`  Deploy ID: ${testId}`);
    console.log(`${'='.repeat(50)}\n`);

    const { payloadFile, imageFile } = createFixtures(testId);

    // For deploy.js we can only validate config and image — it has
    // no simulate mode, so we just verify it starts and reads config.
    // A full test would require a real on-chain deploy.
    console.log(`   Validating configuration...`);

    let passed = true;
    const checks = [];

    // Check env vars
    require('dotenv').config();
    if (process.env.RPC_ENDPOINT) {
        checks.push('  RPC_ENDPOINT: OK');
    } else {
        checks.push('  RPC_ENDPOINT: MISSING');
        passed = false;
    }
    if (process.env.SOLANA_PRIVATE_KEY) {
        checks.push('  SOLANA_PRIVATE_KEY: OK');
    } else {
        checks.push('  SOLANA_PRIVATE_KEY: MISSING');
        passed = false;
    }

    // Check image file
    if (fs.existsSync(imageFile) && fs.statSync(imageFile).size > 0) {
        checks.push(`  Image file: OK (${imageFile})`);
    } else {
        checks.push(`  Image file: MISSING`);
        passed = false;
    }

    // Check deploy.js exists
    if (fs.existsSync(path.join(__dirname, 'deploy.js'))) {
        checks.push('  deploy.js: OK');
    } else {
        checks.push('  deploy.js: MISSING');
        passed = false;
    }

    // Validate we can connect to RPC
    try {
        const { Connection } = require('@solana/web3.js');
        const connection = new Connection(process.env.RPC_ENDPOINT, 'confirmed');
        const version = await connection.getVersion();
        checks.push(`  RPC connection: OK (solana-core ${version['solana-core']})`);
    } catch (e) {
        checks.push(`  RPC connection: FAILED (${e.message})`);
        passed = false;
    }

    checks.forEach(c => console.log(`   | ${c}`));
    cleanup(testId);

    console.log('');
    if (passed) {
        console.log(`  STANDARD LAUNCH TEST: PASSED`);
    } else {
        console.log(`  STANDARD LAUNCH TEST: FAILED`);
    }
    return passed;
}

async function main() {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  LAUNCH PIPELINE TEST SUITE`);
    console.log(`  ${new Date().toISOString()}`);
    console.log(`${'='.repeat(50)}`);

    const results = [];

    if (TEST_BUNDLED) {
        results.push({ name: 'Bundled Launch', passed: await testBundledLaunch() });
    }
    if (TEST_STD) {
        results.push({ name: 'Standard Launch', passed: await testStandardLaunch() });
    }

    // Final report
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  RESULTS`);
    console.log(`${'='.repeat(50)}`);
    for (const r of results) {
        console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}`);
    }

    const allPassed = results.every(r => r.passed);
    console.log(`\n  ${allPassed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'}`);
    console.log(`${'='.repeat(50)}\n`);

    process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
    console.error("TEST FATAL ERROR:", err.message || err);
    process.exit(1);
});
