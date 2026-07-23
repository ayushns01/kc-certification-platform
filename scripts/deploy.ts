import { ethers, network, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/** Constructor takes no arguments; kept as a named constant so both the
 * programmatic verify call and the printed fallback command stay in sync. */
const CONSTRUCTOR_ARGUMENTS: unknown[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function manualVerifyCommand(address: string): string {
  return `npx hardhat verify --network amoy ${address}`;
}

/**
 * Deploys KalachainCertificate to the configured network, then records the
 * result under deployments/<network>.json so the backend and any follow-up
 * scripts (e.g. contract verification) have a stable, checked-in reference
 * to "which address is live on which network".
 *
 * Deliberately never deploys anywhere but the networks configured in
 * hardhat.config.ts (localhost / amoy) — per the assignment's hard
 * constraint, only Amoy testnet is ever targeted pre-hire.
 *
 * On Amoy, with POLYGONSCAN_API_KEY set, this script also attempts
 * Polygonscan verification automatically after a short wait for the
 * explorer to index the new contract. Verification is best-effort: any
 * failure (explorer lag, transient API error, etc.) is caught and logged
 * with the manual fallback command — it must never fail the deploy itself,
 * since the on-chain deployment already succeeded by that point.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);

  console.log(`Network:  ${network.name} (chainId ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const factory = await ethers.getContractFactory("KalachainCertificate");
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  const deploymentTx = contract.deploymentTransaction();
  const txHash = deploymentTx?.hash ?? null;
  const deployedAt = new Date().toISOString();

  console.log(`KalachainCertificate deployed to: ${address}`);
  if (txHash) {
    console.log(`Deployment tx hash: ${txHash}`);
  }

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });

  const outFile = path.join(deploymentsDir, `${network.name}.json`);
  const record = {
    address,
    network: network.name,
    chainId,
    deployer: deployer.address,
    txHash,
    deployedAt,
  };
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + "\n");
  console.log(`Deployment record written to: ${outFile}`);

  if (network.name !== "amoy") {
    return;
  }

  if (!process.env.POLYGONSCAN_API_KEY) {
    console.log(
      "\nPOLYGONSCAN_API_KEY is not set, so automatic verification was skipped.",
    );
    console.log("Set POLYGONSCAN_API_KEY and re-run, or verify manually with:");
    console.log(`  ${manualVerifyCommand(address)}`);
    return;
  }

  // Give Polygonscan's indexer a moment to pick up the new contract creation
  // before we ask it to match source — verifying too soon after the tx is
  // mined is a common source of spurious "does not have bytecode" failures.
  if (deploymentTx) {
    await deploymentTx.wait(5).catch(() => undefined);
  }
  console.log("\nWaiting for Polygonscan to index the new contract...");
  await sleep(30_000);

  try {
    await run("verify:verify", {
      address,
      constructorArguments: CONSTRUCTOR_ARGUMENTS,
    });
    console.log("Polygonscan verification succeeded.");
  } catch (error) {
    console.warn("Automatic Polygonscan verification failed (deploy is still successful):");
    console.warn(error instanceof Error ? error.message : error);
    console.warn("You can retry manually with:");
    console.warn(`  ${manualVerifyCommand(address)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
