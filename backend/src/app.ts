/**
 * Express app factory — createApp({ repo, chainClient, config }) — kept
 * separate from server.ts so tests can build the app against fakes
 * (FakeChainClient + MockJsonRepo on a temp store path) without touching
 * process.env or real network/mail infrastructure.
 */
import express, { type Express } from "express";
import type { AppConfig } from "./config";
import type { IChainClient } from "./chain/types";
import type { IDataRepository } from "./repositories/types";
import { errorHandler } from "./middleware/errorHandler";
import { logger } from "./lib/logger";

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
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.use(express.json());

  const emailService = new EmailService(deps.repo, deps.config, logger);
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
