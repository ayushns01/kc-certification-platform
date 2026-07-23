/**
 * Real-dependency wiring: repo (chosen by DATA_BACKEND), chain client
 * (Ethers.js), startup reconciliation, then listen.
 */
import path from "path";
import { createApp } from "./app";
import { loadConfig, type AppConfig } from "./config";
import type { IDataRepository } from "./repositories/types";
import type { IChainClient } from "./chain/types";
import { MockJsonRepo } from "./repositories/mockJsonRepo";
import { GoogleSheetsRepo } from "./repositories/googleSheetsRepo";
import { EthersChainClient } from "./chain/ethersChainClient";
import { reconcile } from "./services/reconciliationService";
import { logger } from "./lib/logger";

function buildRepo(config: AppConfig): IDataRepository {
  if (config.dataBackend === "json") {
    return new MockJsonRepo(path.join(__dirname, "data", "store.local.json"));
  }
  // config.loadConfig() fail-fasts when DATA_BACKEND=sheets without
  // GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_KEY_FILE, so both are set here.
  return new GoogleSheetsRepo({
    sheetId: config.googleSheetId!,
    keyFile: config.googleServiceAccountKeyFile,
  });
}

function buildChainClient(config: AppConfig): IChainClient {
  if (!config.amoyRpcUrl || !config.deployerPrivateKey || !config.contractAddress) {
    throw new Error(
      "Chain client requires AMOY_RPC_URL (or local RPC URL), DEPLOYER_PRIVATE_KEY, and CONTRACT_ADDRESS to be set",
    );
  }
  return new EthersChainClient(config.amoyRpcUrl, config.deployerPrivateKey, config.contractAddress);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const repo = buildRepo(config);
  if (repo instanceof GoogleSheetsRepo) {
    await repo.ensureSheetStructure();
  }
  const chainClient = buildChainClient(config);

  try {
    await reconcile(repo, chainClient, logger);
  } catch (err) {
    logger.error("reconciliation_failed", { err });
  }

  const app = createApp({ repo, chainClient, config });
  app.listen(config.port, () => {
    logger.info("server_started", { port: config.port, network: config.network, dataBackend: config.dataBackend });
  });
}

main().catch((err) => {
  logger.error("fatal_startup_error", { err });
  process.exit(1);
});
