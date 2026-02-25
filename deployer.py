import subprocess
import json
import os
import re
import uuid

def launch_on_pump_fun(name, ticker, description, image_prompt="", bundled=False, deploy_id=None):
    """
    Deploy a coin to pump.fun.

    If bundled=True, uses bundler.js which generates wallets, funds them,
    and atomically creates the token + buys from all wallets via Jito bundles.
    If bundled=False, uses deploy.js for a simple single-wallet deploy.

    deploy_id: Unique ID for this deployment. When running multiple deploys
    in parallel, each gets its own isolated payload/image/wallet files.
    """
    if deploy_id is None:
        deploy_id = uuid.uuid4().hex[:8]

    mode = "BUNDLED" if bundled else "STANDARD"
    print(f"⚡ [{deploy_id}] INITIALIZING {mode} WEB3 DEPLOYER FOR {ticker}...")

    payload = {
        "name": name,
        "symbol": ticker.replace('$', ''),
        "description": description,
        "imagePath": "placeholder",
        "imagePrompt": image_prompt
    }

    payload_file = f"payload_{deploy_id}.json"
    with open(payload_file, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)

    script = "bundler.js" if bundled else "deploy.js"

    try:
        result = subprocess.run(
            ["node", script, payload_file, "--deploy-id", deploy_id],
            capture_output=True,
            text=True,
            check=False,
            timeout=300  # 5 min timeout for bundled (funding + bundles take time)
        )

        # Clean up payload file
        if os.path.exists(payload_file):
            os.remove(payload_file)

        # Clean up image file
        image_file = f"coin_image_{deploy_id}.png"
        if os.path.exists(image_file):
            os.remove(image_file)

        output = result.stdout
        print(output)

        if result.returncode == 0:
            print(f"✅ [{deploy_id}] {mode} DEPLOYMENT SUCCESSFUL!")

            # Parse MINT_ADDRESS
            match = re.search(r"MINT_ADDRESS:\s*([a-zA-Z0-9]+)", output)
            mint_address = match.group(1) if match else None
            pump_url = f"https://pump.fun/{mint_address}" if mint_address else None

            response = {"success": True, "url": pump_url, "address": mint_address}

            # Parse bundle-specific output
            if bundled:
                wallet_match = re.search(r"BUNDLE_WALLETS:\s*(\d+)", output)
                bundle_match = re.search(r"BUNDLE_IDS:\s*(.+)", output)
                if wallet_match:
                    response["bundle_wallets"] = int(wallet_match.group(1))
                if bundle_match:
                    response["bundle_ids"] = bundle_match.group(1).strip().split(',')

            return response
        else:
            print(f"❌ [{deploy_id}] {mode} DEPLOYMENT FAILED!")
            print(result.stderr)
            return {"success": False, "error": result.stderr}

    except subprocess.TimeoutExpired:
        print(f"❌ [{deploy_id}] ERROR: Deployment script timed out.")
        for f_path in [payload_file, f"coin_image_{deploy_id}.png"]:
            if os.path.exists(f_path):
                os.remove(f_path)
        return {"success": False, "error": "Deployment timed out"}
    except FileNotFoundError:
        print("❌ ERROR: Node.js is not installed.")
        return {"success": False, "error": "Node.js missing"}
