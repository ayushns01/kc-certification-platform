/**
 * Typed environment loading. `loadConfig()` is the only place `process.env`
 * is read for application config, and it fails fast when required variables
 * for the selected mode are missing — better a loud boot-time error than a
 * confusing runtime failure mid-request.
 *
 * Tests never call `loadConfig()` — they construct an `AppConfig` object
 * literal directly and pass it into `createApp({ repo, chainClient, config })`,
 * so config validation never gets in the way of test setup.
 */
import dotenv from "dotenv";

export type Network = "local" | "amoy" | "polygon";
export type DataBackend = "json" | "sheets";
export type EmailMode = "manual" | "auto";

export interface AppConfig {
  network: Network;
  amoyRpcUrl?: string;
  deployerPrivateKey?: string;
  contractAddress?: string;
  polygonscanApiKey?: string;

  dataBackend: DataBackend;
  googleSheetId?: string;
  googleServiceAccountKeyFile?: string;
  sheetPollIntervalMs: number;

  emailMode: EmailMode;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  emailFrom: string;

  port: number;
  baseUrl: string;
  adminApiKey: string;
}

function isNetwork(value: string): value is Network {
  return value === "local" || value === "amoy" || value === "polygon";
}

function isDataBackend(value: string): value is DataBackend {
  return value === "json" || value === "sheets";
}

function isEmailMode(value: string): value is EmailMode {
  return value === "manual" || value === "auto";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Populate process.env from .env (no-op for keys already set, e.g. in CI).
  // Tests never call loadConfig() — they build an AppConfig literal directly.
  dotenv.config();
  const source = env;

  const networkRaw = source.NETWORK ?? "local";
  if (!isNetwork(networkRaw)) {
    throw new Error(`Invalid NETWORK: ${networkRaw} (expected local | amoy | polygon)`);
  }

  const dataBackendRaw = source.DATA_BACKEND ?? "json";
  if (!isDataBackend(dataBackendRaw)) {
    throw new Error(`Invalid DATA_BACKEND: ${dataBackendRaw} (expected json | sheets)`);
  }

  const emailModeRaw = source.EMAIL_MODE ?? "manual";
  if (!isEmailMode(emailModeRaw)) {
    throw new Error(`Invalid EMAIL_MODE: ${emailModeRaw} (expected manual | auto)`);
  }

  const adminApiKey = source.ADMIN_API_KEY;
  if (!adminApiKey) {
    throw new Error("ADMIN_API_KEY is required to guard admin routes");
  }

  if ((networkRaw === "amoy" || networkRaw === "polygon")) {
    if (!source.AMOY_RPC_URL) throw new Error(`AMOY_RPC_URL is required when NETWORK=${networkRaw}`);
    if (!source.DEPLOYER_PRIVATE_KEY) throw new Error(`DEPLOYER_PRIVATE_KEY is required when NETWORK=${networkRaw}`);
    if (!source.CONTRACT_ADDRESS) throw new Error(`CONTRACT_ADDRESS is required when NETWORK=${networkRaw}`);
  }

  if (dataBackendRaw === "sheets" && !source.GOOGLE_SHEET_ID) {
    throw new Error("GOOGLE_SHEET_ID is required when DATA_BACKEND=sheets");
  }

  return {
    network: networkRaw,
    amoyRpcUrl: source.AMOY_RPC_URL,
    deployerPrivateKey: source.DEPLOYER_PRIVATE_KEY,
    contractAddress: source.CONTRACT_ADDRESS,
    polygonscanApiKey: source.POLYGONSCAN_API_KEY,

    dataBackend: dataBackendRaw,
    googleSheetId: source.GOOGLE_SHEET_ID,
    googleServiceAccountKeyFile: source.GOOGLE_SERVICE_ACCOUNT_KEY_FILE,
    sheetPollIntervalMs: Number(source.SHEET_POLL_INTERVAL_MS ?? 15000),

    emailMode: emailModeRaw,
    smtpHost: source.SMTP_HOST || undefined,
    smtpPort: source.SMTP_PORT ? Number(source.SMTP_PORT) : undefined,
    smtpUser: source.SMTP_USER || undefined,
    smtpPass: source.SMTP_PASS || undefined,
    emailFrom: source.EMAIL_FROM || "Kalachain Certificates <certificates@kalachain.example>",

    port: Number(source.PORT ?? 3000),
    baseUrl: source.BASE_URL || `http://localhost:${Number(source.PORT ?? 3000)}`,
    adminApiKey,
  };
}
