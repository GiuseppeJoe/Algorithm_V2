import subprocess
import json
import os
import sys

def run_mint_test():
    print("🧪 INITIATING END-TO-END MINT TEST 🧪")
    print("Testing pipeline: Python Payload -> Node.js Engine -> Solana Mainnet\n")
    
    # 1. Ensure the image file exists (so deploy.js doesn't crash reading it)
    if not os.path.exists("coin_image.png"):
        print("🖼️ Creating a dummy 1x1 'coin_image.png' for the test...")
        # Hex data for a tiny, valid 1x1 transparent PNG
        dummy_png = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82'
        with open("coin_image.png", "wb") as f:
            f.write(dummy_png)
            
    # 2. Create the exact payload the AI usually generates
    payload = {
        "name": "Pipeline Verification Token",
        "symbol": "PIPETEST",
        "description": "This is a live network test of the bare-metal Pump.fun deployment script.",
    }
    
    print("📦 Generating 'payload.json'...")
    with open("payload.json", "w") as f:
        json.dump(payload, f)
        
    # 3. Execute deploy.js and stream the output live
    print("\n🚀 Executing deploy.js (Talking to Solana Mainnet)...")
    print("=" * 60)
    
    try:
        # Popen allows us to see the console output in real-time
        process = subprocess.Popen(
            ["node", "deploy.js", "payload.json"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True
        )
        
        success = False
        for line in process.stdout:
            # Print the Node.js output directly to the Python terminal
            sys.stdout.write(f"   | {line}")
            sys.stdout.flush()
            
            if "SUCCESS!" in line:
                success = True
                
        process.wait()
        
        print("=" * 60)
        
        # 4. Final Verification
        if success:
            print("\n✅ TEST PASSED: The token was successfully minted on the blockchain!")
            print("You can verify the coin in your wallet or on the Pump.fun website.")
        else:
            print("\n❌ TEST FAILED: The transaction did not complete. Check the logs above for the specific error.")
            
    except Exception as e:
        print(f"\n❌ Python Execution Error: {e}")
        
    finally:
        # Cleanup the payload so it doesn't clutter your folder
        if os.path.exists("payload.json"):
            os.remove("payload.json")

if __name__ == "__main__":
    run_mint_test()