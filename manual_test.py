import deployer

print("🧪 Starting Manual Simulation Test...")

# Simulate a detected trend
fake_name = "Test Coin AI"
fake_ticker = "$TESTAI"
fake_desc = "This is a verification test for the AI deployer pipeline."

# Call the deployer (which calls Node.js)
success = deployer.launch_on_pump_fun(fake_name, fake_ticker, fake_desc)

if success:
    print("\n✅ PYTHON: Process finished successfully.")
else:
    print("\n❌ PYTHON: Process failed.")