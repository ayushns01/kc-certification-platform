/**
 * Express app factory — createApp({ repo, chainClient, config }) — kept
 * separate from server.ts so tests can build the app against fakes
 * (FakeChainClient + MockJsonRepo on a temp store path) without touching
 * process.env or real network/mail infrastructure.
 */
import express, { type Express } from "express";
import type { Transporter } from "nodemailer";
import type { AppConfig } from "./config";
import type { IChainClient } from "./chain/types";
import type { IDataRepository } from "./repositories/types";
import { errorHandler } from "./middleware/errorHandler";
import { logger as defaultLogger } from "./lib/logger";

import { RegistrationService } from "./services/registrationService";
import { PaymentService } from "./services/paymentService";
import { ApprovalService } from "./services/approvalService";
import { SubmissionService } from "./services/submissionService";
import { EmailService } from "./services/emailService";
import { VerificationService } from "./services/verificationService";

import { workshopsRouter } from "./routes/workshops";
import { registrationsRouter } from "./routes/registrations";
import { submissionsRouter } from "./routes/submissions";
import { metadataRouter } from "./routes/metadata";
import { verifyRouter } from "./routes/verify";
import { adminRouter } from "./routes/admin";

export interface AppDeps {
  repo: IDataRepository;
  chainClient: IChainClient;
  config: AppConfig;
  /** Test-only: inject a transporter (e.g. one that throws) into EmailService. */
  emailTransporter?: Transporter;
  /** Injectable for tests (noop keeps test output clean); defaults to the real logger. */
  logger?: typeof defaultLogger;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());

  const logger = deps.logger ?? defaultLogger;
  const emailService = new EmailService(deps.repo, deps.config, logger, deps.emailTransporter);
  const registrationService = new RegistrationService(deps.repo);
  const paymentService = new PaymentService(deps.repo);
  const approvalService = new ApprovalService(deps.repo, deps.chainClient, deps.config, emailService);
  const submissionService = new SubmissionService(deps.repo, deps.chainClient, deps.config);
  const verificationService = new VerificationService(deps.repo, deps.chainClient, deps.config);

  app.use(workshopsRouter(deps.repo));
  app.use(registrationsRouter(registrationService));
  app.use(submissionsRouter(submissionService));
  app.use(metadataRouter(deps.repo));
  app.use(verifyRouter(verificationService));
  app.use(
    "/api/admin",
    adminRouter({
      repo: deps.repo,
      config: deps.config,
      paymentService,
      approvalService,
      submissionService,
      emailService,
    }),
  );

  app.use(errorHandler);

  return app;
}
