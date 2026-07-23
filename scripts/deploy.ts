import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys KalachainCertificate to the configured network, then records the
 * result under deployments/<network>.json so the backend and any follow-up
 * scripts (e.g. contract verification) have a stable, checked-in reference
 * to "which address is live on which network".
 *
 * Deliberately does NOT deploy anywhere automatically and does NOT run
 * verification itself — per the assignment's hard constraint, only Amoy
 * testnet is ever targeted, and verification is a separate, explicit step
 * the operator runs by hand.
 */
async function main() {
  const [deployer] = await ethers.getSigners();

  console.log(`Network:  ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);

  const factory = await ethers.getContractFactory("KalachainCertificate");
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const deploymentTx = contract.deploymentTransaction();
  const deployedAt = new Date().toISOString();

  console.log(`KalachainCertificate deployed to: ${address}`);
  if (deploymentTx) {
    console.log(`Deployment tx hash: ${deploymentTx.hash}`);
  }

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });

  const outFile = path.join(deploymentsDir, `${network.name}.json`);
  const record = {
    address,
    network: network.name,
    deployedAt,
  };
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + "\n");
  console.log(`Deployment record written to: ${outFile}`);

  if (network.name === "amoy" && process.env.POLYGONSCAN_API_KEY) {
    console.log("\nTo verify this contract on Polygonscan (Amoy), run:");
    console.log(`  npx hardhat verify --network amoy ${address}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
