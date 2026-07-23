/**
 * Shared test harness: a fresh MockJsonRepo on a temp file + FakeChainClient
 * per call, wired through the real createApp() factory. Not a *.test.ts
 * file itself (vitest only picks up backend/src/**\/*.test.ts), just a
 * helper imported by the actual test suites.
 */
import fs from "fs";
import os from "os";
import path from "path";
import type { Transporter } from "nodemailer";
import { createApp } from "../app";
import type { AppConfig } from "../config";
import type { IDataRepository } from "../repositories/types";
import { MockJsonRepo } from "../repositories/mockJsonRepo";
import { FakeChainClient } from "../chain/fakeChainClient";

export const TEST_ADMIN_API_KEY = "test-admin-key";

export function buildTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    network: "local",
    dataBackend: "json",
    sheetPollIntervalMs: 15000,
    emailMode: "manual",
    emailFrom: "Kalachain Test <test@kalachain.example>",
    port: 0,
    baseUrl: "http://localhost:3000",
    adminApiKey: TEST_ADMIN_API_KEY,
    ...overrides,
  };
}

export interface TestHarness {
  app: ReturnType<typeof createApp>;
  repo: IDataRepository;
  chainClient: FakeChainClient;
  config: AppConfig;
  storePath: string;
}

export function buildTestApp(
  overrides: Partial<AppConfig> = {},
  extras: { emailTransporter?: Transporter } = {},
): TestHarness {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kalachain-test-"));
  const storePath = path.join(tmpDir, "store.local.json");
  const repo = new MockJsonRepo(storePath);
  const chainClient = new FakeChainClient();
  const config = buildTestConfig(overrides);
  const noop = () => undefined;
  const app = createApp({
    repo,
    chainClient,
    config,
    emailTransporter: extras.emailTransporter,
    logger: { debug: noop, info: noop, warn: noop, error: noop },
  });
  return { app, repo, chainClient, config, storePath };
}
