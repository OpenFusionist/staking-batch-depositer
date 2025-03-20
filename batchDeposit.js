const { ContainerType, ByteVectorType, NumberUintType } = require("@chainsafe/ssz");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

// ENV
const { 
  PROVIDER_URL: providerUrl, 
  PRIVATE_KEY: privateKey, 
  CONTRACT_ADDRESS: contractAddress,
  GAS_LIMIT: gasLimit,
  GAS_PRICE: gasPrice,
  MAX_RETRIES: maxRetries = 3,
  RETRY_DELAY: retryDelay = 1000
} = process.env;

// contract ABI definition
const contractABI = [
  {
    inputs: [
      { internalType: "bytes", name: "pubkey", type: "bytes" },
      { internalType: "bytes", name: "withdrawal_credentials", type: "bytes" },
      { internalType: "bytes", name: "signature", type: "bytes" },
      { internalType: "bytes32", name: "deposit_data_root", type: "bytes32" },
    ],
    name: "deposit",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  }
];

const depositDataContainer = new ContainerType({
  fields: {
    pubkey: new ByteVectorType({ length: 48 }),
    withdrawalCredentials: new ByteVectorType({ length: 32 }),
    amount: new NumberUintType({ byteLength: 8 }),
    signature: new ByteVectorType({ length: 96 }),
  },
});

// Helper function to convert buffer to hex string
function buf2hex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(x => `00${x.toString(16)}`.slice(-2))
    .join("");
}

// Helper function to wait for specified milliseconds
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const LockManager = {

  createDirectory(filePath) {
    const lockDir = `${filePath}-locks`;
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir);
    }
    return lockDir;
  },
  
  checkLock(lockDir, pubkey) {
    return fs.existsSync(path.join(lockDir, `${pubkey}.lock`));
  },

  createLock(lockDir, pubkey) {
    fs.writeFileSync(path.join(lockDir, `${pubkey}.lock`), "");
  }
};

async function processDepositJson(filePath) {
  // 1) init ethers.js
  let provider;
  try {
    provider = new ethers.providers.JsonRpcProvider(providerUrl);
    await provider.getNetwork(); // Test the connection
  } catch (error) {
    console.error("\x1b[31mERROR: Failed to connect to provider\x1b[0m");
    console.error(`Provider URL: ${providerUrl}`);
    console.error(`Error details: ${error.message}`);
    console.error("Please check your internet connection and provider URL in .env file");
    process.exit(1);
  }

  if (!privateKey) {
    console.error("\x1b[31mERROR: Private key is missing\x1b[0m");
    console.error("Please set PRIVATE_KEY in your .env file");
    process.exit(1);
  }

  if (!contractAddress) {
    console.error("\x1b[31mERROR: Deposit contract address is missing\x1b[0m");
    console.error("Please set CONTRACT_ADDRESS in your .env file");
    process.exit(1);
  }

  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(contractAddress, contractABI, wallet);

  // 2) read deposit data
  let depositData;
  try {
    depositData = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.error(`\x1b[31mERROR: Failed to parse deposit data file: ${filePath}\x1b[0m`);
    console.error(`Error details: ${error.message}`);
    process.exit(1);
  }

  const lockDir = LockManager.createDirectory(filePath);
  let successCount = 0;
  let failureCount = 0;

  console.log(`\x1b[36mProcessing ${depositData.length} deposit entries...\x1b[0m`);

  // 3) process each deposit data
  for (let i = 0; i < depositData.length; i++) {
    const data = depositData[i];
    const pubkeyHex = data.pubkey;
    
    console.log(`\x1b[36m[${i+1}/${depositData.length}] Processing pubkey: ${pubkeyHex.substring(0, 10)}...\x1b[0m`);
    
    // 3.1)
    if (LockManager.checkLock(lockDir, pubkeyHex)) {
      console.log(`Transaction for pubkey ${pubkeyHex.substring(0, 10)}... already processed. Skipping.`);
      successCount++;
      continue;
    }

    // 3.2) prepare deposit data
    const depositParams = {
      pubkey: Buffer.from(pubkeyHex, "hex"),
      withdrawalCredentials: Buffer.from(data.withdrawal_credentials, "hex"),
      amount: data.amount,
      signature: Buffer.from(data.signature, "hex")
    };

    // 3.3) prepare tx data
    const txParams = {
      value: ethers.utils.parseEther(String(depositParams.amount / 1e9)),
      gasLimit,
      gasPrice: ethers.utils.parseUnits(gasPrice, "gwei"),
    };

    let retryCount = 0;
    let success = false;

    while (retryCount < maxRetries && !success) {
      try {
        if (retryCount > 0) {
          console.log(`\x1b[33mRetrying transaction (${retryCount}/${maxRetries})...\x1b[0m`);
          await sleep(retryDelay);
        }

        // 3.4) calculate deposit root and send transaction
        const depositRoot = `0x${buf2hex(depositDataContainer.hashTreeRoot(depositParams))}`;        
        const tx = await contract.deposit(
          depositParams.pubkey,
          depositParams.withdrawalCredentials,
          depositParams.signature,
          depositRoot,
          txParams
        );

        console.log(`\x1b[32mTransaction sent. Hash: ${tx.hash}\x1b[0m`);        
        LockManager.createLock(lockDir, pubkeyHex);
        success = true;
        successCount++;

      } catch (error) {
        retryCount++;
        
        if (error.code === 'INSUFFICIENT_FUNDS') {
          console.error(`\x1b[31mERROR: Insufficient funds in wallet\x1b[0m`);
          console.error(`Required: ${ethers.utils.formatEther(txParams.value)} ETH plus gas`);
          console.error(`Please fund your wallet and try again`);
          process.exit(1);
        } else if (error.code === 'NETWORK_ERROR') {
          console.error(`\x1b[31mERROR: Network connection issue\x1b[0m`);
          console.error(`Error details: ${error.message}`);
          console.error(`Retrying in ${retryDelay/1000} seconds...`);
        } else if (error.code === 'TIMEOUT') {
          console.error(`\x1b[31mERROR: Transaction timed out\x1b[0m`);
          console.error(`Error details: ${error.message}`);
          console.error(`Retrying in ${retryDelay/1000} seconds...`);
        } else if (error.code === 'UNPREDICTABLE_GAS_LIMIT') {
          console.error(`\x1b[31mERROR: Gas estimation failed\x1b[0m`);
          console.error(`Error details: ${error.message}`);
          console.error(`Try setting a higher GAS_LIMIT in your .env file`);
          failureCount++;
          break;
        } else if (error.code === 'NONCE_EXPIRED') {
          console.error(`\x1b[31mERROR: Nonce has already been used\x1b[0m`);
          console.error(`Error details: ${error.message}`);
          console.error(`Retrying with new nonce...`);
        } else {
          console.error(`\x1b[31mERROR sending transaction:\x1b[0m`, error);
          console.error(`Error message: ${error.message}`);
          console.error(`Error code: ${error.code || 'unknown'}`);
          
          if (retryCount < maxRetries) {
            console.error(`Retrying in ${retryDelay/1000} seconds...`);
          }
        }
      }
    }
    
    if (!success) {
      failureCount++;
      console.error(`\x1b[31mFailed to process pubkey ${pubkeyHex.substring(0, 10)}... after ${maxRetries} attempts\x1b[0m`);
    }
  }

  // Summary report
  console.log("\n\x1b[36m====== Deposit Summary ======\x1b[0m");
  console.log(`\x1b[32mSuccessful deposits: ${successCount}/${depositData.length}\x1b[0m`);
  
  if (failureCount > 0) {
    console.log(`\x1b[31mFailed deposits: ${failureCount}/${depositData.length}\x1b[0m`);
    console.log("\x1b[33mTips for failed deposits:\x1b[0m");
    console.log("1. Check your internet connection");
    console.log("2. Verify you have enough ACE in your wallet");
    console.log("3. Increase GAS_LIMIT or adjust GAS_PRICE in .env file");
    console.log("4. Run the script again - already processed deposits will be skipped");
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  // 1) verify args
  if (args.length !== 1) {
    console.error("\x1b[31mERROR: Invalid arguments\x1b[0m");
    console.error("usage: node batchDeposit.js <deposit_data.json>");
    process.exit(1);
  }

  const filePath = args[0];

  // 2) verify file exists
  if (!fs.existsSync(filePath)) {
    console.error(`\x1b[31mERROR: deposit data file not found: ${filePath}\x1b[0m`);
    console.error("Please check the file path and try again");
    process.exit(1);
  }

  console.log("\x1b[36m====== Ethereum Staking Batch Depositer ======\x1b[0m");
  console.log(`Processing file: ${filePath}`);

  try {
    // 3) process deposit data && send transaction
    await processDepositJson(filePath);
  } catch (error) {
    console.error("\x1b[31mFatal error occurred:\x1b[0m", error);
    process.exit(1);
  }
}

main();
