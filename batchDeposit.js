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
  GAS_PRICE: gasPrice
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


function buf2hex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(x => `00${x.toString(16)}`.slice(-2))
    .join("");
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
  const provider = new ethers.providers.JsonRpcProvider(providerUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const contract = new ethers.Contract(contractAddress, contractABI, wallet);

  // 2) read deposit data
  const depositData = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const lockDir = LockManager.createDirectory(filePath);

  // 3) process each deposit data
  for (const data of depositData) {
    const pubkeyHex = data.pubkey;
    
    // 3.1)
    if (LockManager.checkLock(lockDir, pubkeyHex)) {
      console.log(`Transaction for pubkey ${pubkeyHex} already processed. Skipping.`);
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

    try {
      // 3.4) calculate deposit root and send transaction
      const depositRoot = `0x${buf2hex(depositDataContainer.hashTreeRoot(depositParams))}`;
      const tx = await contract.deposit(
        depositParams.pubkey,
        depositParams.withdrawalCredentials,
        depositParams.signature,
        depositRoot,
        txParams
      );

      console.log("Transaction sent. Hash:", tx.hash);
      LockManager.createLock(lockDir, pubkeyHex);
    } catch (error) {
      console.error("Error sending transaction:", error);
    }
  }
}


async function main() {
  const args = process.argv.slice(2);
  
  // 1) verify args
  if (args.length !== 1) {
    console.error("usage: node batchDeposit.js <deposit_data.json>");
    process.exit(1);
  }

  const filePath = args[0];

  // 2) verify file exists
  if (!fs.existsSync(filePath)) {
    console.error(`deposit data file not found: ${filePath}`);
    process.exit(1);
  }

  // 3) process deposit data && send transaction
  await processDepositJson(filePath);
}

main();
