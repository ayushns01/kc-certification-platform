/**
 * Worker entrypoint (`npm run worker`) — the JD's core deliverable: a
 * process linking Google Sheet row edits to the blockchain mint pipeline.
 *
 * Boots the same config/repo/chain/service stack as the API server, wires
 * the service-backed WorkflowActions adapter into SheetSyncWorker, and
 * polls. Runs as its own process (separate from `npm run dev`) so the
 * worker can be restarted or redeployed independently of the API.
 */
import { loadConfig } from "../config";
import { EthersChainClient } from "../chain/ethersChainClient";
import { GoogleSheetsRepo } from "../repositories/googleSheetsRepo";
import { PaymentService } from "../services/paymentService";
import { ApprovalService } from "../services/approvalService";
import { EmailService } from "../services/emailService";
import { reconcile } from "../services/reconciliationService";
import { logger } from "../lib/logger";
import { SheetSyncWorker } from "./sheetSyncWorker";
import { buildWorkflowActions } from "./workflowActionsAdapter";

async function main(): Promise<void> {
  const config = loadConfig();

  if (config.dataBackend !== "sheets") {
    throw new Error(
      "The sheet sync worker requires DATA_BACKEND=sheets (with GOOGLE_SHEET_ID and " +
        "GOOGLE_SERVICE_ACCOUNT_KEY_FILE set) — see docs/SHEETS-SETUP.md. " +
        "With DATA_BACKEND=json the REST API alone drives the workflow; there is no sheet to sync.",
    );
  }
  if (!config.amoyRpcUrl || !config.deployerPrivateKey || !config.contractAddress) {
    throw new Error("Worker requires AMOY_RPC_URL, DEPLOYER_PRIVATE_KEY, and CONTRACT_ADDRESS to be set");
  }

  const repo = new GoogleSheetsRepo({
    sheetId: config.googleSheetId!,
    keyFile: config.googleServiceAccountKeyFile,
  });
  await repo.ensureSheetStructure();

  const chainClient = new EthersChainClient(config.amoyRpcUrl, config.deployerPrivateKey, config.contractAddress);

  // Same crash-recovery pass the API server runs: heal records whose mint
  // landed on-chain but whose write-back was lost.
  try {
    await reconcile(repo, chainClient, logger);
  } catch (err) {
    logger.error("reconciliation_failed", { err });
  }

  const emailService = new EmailService(repo, config, logger);
  const paymentService = new PaymentService(repo);
  const approvalService = new ApprovalService(repo, chainClient, config, emailService);

  const worker = new SheetSyncWorker({
    accessor: repo.registrationsAccessor(),
    actions: buildWorkflowActions({ repo, paymentService, approvalService, emailService }),
    pollIntervalMs: config.sheetPollIntervalMs,
    logger,
  });

  worker.start();
  logger.info("sheet_sync_worker_started", {
    sheetId: config.googleSheetId,
    pollIntervalMs: config.sheetPollIntervalMs,
    network: config.network,
  });

  const shutdown = (signal: string) => {
    logger.info("sheet_sync_worker_stopping", { signal });
    worker.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("fatal_worker_startup_error", { err: err instanceof Error ? err.message : err });
  process.exit(1);
});
