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
import { EthersChainClient } from "./chain/ethersChainClient";
import { reconcile } from "./services/reconciliationService";
import { logger } from "./lib/logger";

function buildRepo(config: AppConfig): IDataRepository {
  if (config.dataBackend === "json") {
    return new MockJsonRepo(path.join(__dirname, "data", "store.local.json"));
  }

  // Sheets backend is built in parallel by another agent. Lazy `require`
  // behind a try/catch so a missing repositories/googleSheetsRepo.ts never
  // breaks compilation of this file — it only fails at runtime, with a
  // clear message, if DATA_BACKEND=sheets is actually selected before that
  // file exists.
  try {
    const mod = require("./repositories/googleSheetsRepo");
    const GoogleSheetsRepo = mod.GoogleSheetsRepo ?? mod.default;
    return new GoogleSheetsRepo(config);
  } catch (err) {
    throw new Error(
      "DATA_BACKEND=sheets requires backend/src/repositories/googleSheetsRepo.ts, which is not available yet: " +
        (err instanceof Error ? err.message : String(err)),
    );
  }
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
