import subprocess
import json
import os
import re

def launch_on_pump_fun(name, ticker, description, image_prompt=""):
    print(f"⚡ INITIALIZING WEB3 DEPLOYER FOR {ticker}...")
    
    payload = {
        "name": name,
        "symbol": ticker.replace('$', ''),
        "description": description,
        "imagePath": "placeholder",
        "imagePrompt": image_prompt
    }
    
    payload_file = "payload.json"
    with open(payload_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    
    try:
        result = subprocess.run(
            ["node", "deploy.js", payload_file],
            capture_output=True,
            text=True,
            check=False 
        )
        
        # Clean up
        if os.path.exists(payload_file):
            os.remove(payload_file)

        if result.returncode == 0:
            print("✅ DEPLOYMENT SCRIPT SUCCESSFUL!")
            
            # PARSE THE MINT ADDRESS
            output = result.stdout
            print(output) # Print raw output for debugging
            
            # Regex to find "MINT_ADDRESS: <address>"
            match = re.search(r"MINT_ADDRESS:\s*([a-zA-Z0-9]+)", output)
            
            if match:
                mint_address = match.group(1)
                pump_url = f"https://pump.fun/{mint_address}"
                return {"success": True, "url": pump_url, "address": mint_address}
            else:
                print("⚠️ Could not find Mint Address in output.")
                return {"success": True, "url": None, "address": None}
        else:
            print("❌ WEB3 DEPLOYMENT FAILED!")
            print(result.stderr)
            return {"success": False, "error": result.stderr}
        
    except FileNotFoundError:
        print("❌ ERROR: Node.js is not installed.")
        return {"success": False, "error": "Node.js missing"}