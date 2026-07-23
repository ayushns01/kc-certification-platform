/**
 * Phase-2 evaluation flow: submission -> evaluation draft (repeatable) ->
 * finalize (locks + auto-mints the graded certificate, P2-4). Mirrors the
 * approve/retry-mint failure semantics from approvalService: finalize is
 * one logical operation (lock evaluation + mint), a chain failure never
 * fakes success, and retryFinalizeMint() heals from an already-minted chain
 * state instead of risking a double mint.
 *
 * Grade is ALWAYS derived server-side by deriveGrade() (domain/types.ts).
 * The evaluation schema is `.strict()` so a client-supplied `grade` field is
 * rejected outright (400) rather than silently ignored.
 */
import { z } from "zod";
import type { AppConfig } from "../config";
import type { IChainClient, MintedEvent } from "../chain/types";
import type { CertificateRecord, Registration, Submission, Workshop } from "../domain/types";
import { deriveGrade } from "../domain/types";
import type { IDataRepository } from "../repositories/types";
import { ConflictError, IllegalTransitionError, NotFoundError } from "../domain/errors";
import { generateCertId, generateSubmissionId, recordIdFor } from "../lib/ids";
import { buildEvaluationDomainMetadata } from "./metadataService";
import { canonicalHash } from "../lib/canonicalHash";
import { checkAlreadyMinted, performMint, type MintOutcome } from "./mintingCore";

const submissionSchema = z.object({
  registrationId: z.string().trim().min(1, "registrationId is required"),
  recordingUrl: z.string().trim().url("recordingUrl must be a valid URL"),
});

const evaluationSchema = z
  .object({
    evaluatorName: z.string().trim().min(1, "evaluatorName is required"),
    marks: z.number().min(0).max(100),
    parameters: z.record(z.string(), z.number()),
    comments: z.string().trim().min(1, "comments is required"),
    audioFeedbackUrl: z.string().trim().url("audioFeedbackUrl must be a valid URL"),
  })
  .strict(); // rejects any extra key, e.g. a client-supplied "grade" — grade is server-derived only

export class SubmissionService {
  constructor(
    private readonly repo: IDataRepository,
    private readonly chainClient: IChainClient,
    private readonly config: AppConfig,
  ) {}

  async createSubmission(input: unknown): Promise<Submission> {
    const parsed = submissionSchema.parse(input);

    const reg = await this.repo.getRegistration(parsed.registrationId);
    if (!reg) throw new NotFoundError(`Unknown registration: ${parsed.registrationId}`);
    if (reg.phase !== 2) {
      throw new ConflictError(`Registration ${parsed.registrationId} is not a Phase-2 registration`);
    }

    const existing = (await this.repo.listSubmissions()).find((s) => s.registrationId === reg.id);
    if (existing) {
      throw new ConflictError(`A submission already exists for registration ${reg.id}`);
    }

    const now = new Date().toISOString();
    const submission: Submission = {
      id: generateSubmissionId(),
      registrationId: reg.id,
      recordingUrl: parsed.recordingUrl,
      state: "SUBMITTED",
      mintStatus: "NONE",
      createdAt: now,
      updatedAt: now,
    };
    await this.repo.createSubmission(submission);
    return submission;
  }

  async upsertEvaluation(submissionId: string, input: unknown): Promise<Submission> {
    const parsed = evaluationSchema.parse(input);

    const sub = await this.repo.getSubmission(submissionId);
    if (!sub) throw new NotFoundError(`Unknown submission: ${submissionId}`);
    if (sub.state !== "SUBMITTED" && sub.state !== "EVALUATED") {
      throw new IllegalTransitionError(
        sub.state,
        `Cannot record evaluation: submission ${submissionId} is ${sub.state}, expected SUBMITTED or EVALUATED`,
      );
    }

    sub.evaluation = {
      evaluatorName: parsed.evaluatorName,
      marks: parsed.marks,
      grade: deriveGrade(parsed.marks),
      parameters: parsed.parameters,
      comments: parsed.comments,
      audioFeedbackUrl: parsed.audioFeedbackUrl,
    };
    sub.state = "EVALUATED";
    sub.updatedAt = new Date().toISOString();
    await this.repo.updateSubmission(sub);
    return sub;
  }

  async finalize(submissionId: string): Promise<MintOutcome> {
    const sub = await this.repo.getSubmission(submissionId);
    if (!sub) throw new NotFoundError(`Unknown submission: ${submissionId}`);
    if (sub.state === "FINALIZED") {
      throw new IllegalTransitionError(sub.state, `Submission ${submissionId} is already finalized`);
    }
    if (sub.state !== "EVALUATED") {
      throw new IllegalTransitionError(
        sub.state,
        `Cannot finalize: submission ${submissionId} is ${sub.state}, expected EVALUATED`,
      );
    }
    // Double-mint guard for the crash window: once a mint has been ATTEMPTED
    // (MINTING persisted, then process died / chain failed), state is still
    // EVALUATED but a certId already exists. Re-running finalize here with a
    // fresh generateCertId() would sidestep the on-chain mintedFor guard
    // (keyed on certId) and mint a second token — so recovery goes through
    // retry-mint, which reuses the certId and heals from chain state.
    if (sub.mintStatus === "MINTING" || sub.mintStatus === "FAILED") {
      throw new ConflictError(
        `Submission ${submissionId} already has a mint attempt (mintStatus ${sub.mintStatus}); ` +
          `use POST /api/admin/submissions/${submissionId}/retry-mint`,
      );
    }

    const { reg, workshop } = await this.loadContext(sub);

    const certId = sub.certId ?? generateCertId();
    sub.mintStatus = "MINTING";
    sub.certId = certId;
    sub.updatedAt = new Date().toISOString();
    await this.repo.updateSubmission(sub);

    return this.mintFor(sub, reg, workshop, certId);
  }

  async retryFinalizeMint(submissionId: string): Promise<MintOutcome> {
    const sub = await this.repo.getSubmission(submissionId);
    if (!sub) throw new NotFoundError(`Unknown submission: ${submissionId}`);
    if (sub.state === "FINALIZED") {
      throw new IllegalTransitionError(sub.state, `Submission ${submissionId} is already finalized`);
    }
    if (sub.state !== "EVALUATED") {
      throw new IllegalTransitionError(
        sub.state,
        `Cannot retry finalize mint: submission ${submissionId} is ${sub.state}, expected EVALUATED`,
      );
    }

    const { reg, workshop } = await this.loadContext(sub);
    const certId = sub.certId ?? generateCertId();

    const alreadyMinted = await checkAlreadyMinted(this.chainClient, certId);
    if (alreadyMinted) {
      return this.healAlreadyMinted(sub, reg, workshop, certId, alreadyMinted.tokenId);
    }

    sub.mintStatus = "MINTING";
    sub.certId = certId;
    sub.updatedAt = new Date().toISOString();
    await this.repo.updateSubmission(sub);

    return this.mintFor(sub, reg, workshop, certId);
  }

  private async loadContext(sub: Submission): Promise<{ reg: Registration; workshop: Workshop }> {
    const reg = await this.repo.getRegistration(sub.registrationId);
    if (!reg) throw new NotFoundError(`Registration ${sub.registrationId} not found for submission ${sub.id}`);
    const workshop = await this.repo.getWorkshop(reg.workshopId);
    if (!workshop) throw new NotFoundError(`Workshop ${reg.workshopId} not found`);
    return { reg, workshop };
  }

  private async mintFor(
    sub: Submission,
    reg: Registration,
    workshop: Workshop,
    certId: string,
  ): Promise<MintOutcome> {
    const domainMetadata = buildEvaluationDomainMetadata(sub, reg, workshop, certId);

    return performMint({
      repo: this.repo,
      chainClient: this.chainClient,
      config: this.config,
      certId,
      certType: 1,
      sourceId: sub.id,
      domainMetadata,
      recipientEmail: reg.email,
      retryUrl: `/api/admin/submissions/${sub.id}/retry-mint`,
      onFailure: async (mintError) => {
        sub.mintStatus = "FAILED";
        sub.mintError = mintError;
        sub.updatedAt = new Date().toISOString();
        await this.repo.updateSubmission(sub);
      },
      onSuccess: async () => {
        sub.state = "FINALIZED";
        sub.mintStatus = "MINTED";
        sub.mintError = undefined;
        sub.updatedAt = new Date().toISOString();
        await this.repo.updateSubmission(sub);
        // Phase-2 evaluation certs have no separate email-dispatch step in
        // this assessment's scope (see docs/API.md) — not applicable.
        return "NOT_APPLICABLE";
      },
    });
  }

  private async healAlreadyMinted(
    sub: Submission,
    reg: Registration,
    workshop: Workshop,
    certId: string,
    tokenId: number,
  ): Promise<MintOutcome> {
    const domainMetadata = buildEvaluationDomainMetadata(sub, reg, workshop, certId);
    const metadataHash = canonicalHash(domainMetadata);
    const recordId = recordIdFor(certId);

    let existingCert = await this.repo.getCertificate(certId);
    if (!existingCert) {
      const events: MintedEvent[] = await this.chainClient.getMintedEvents();
      const event = events.find((e) => e.recordId === recordId);
      const onChainCert = await this.chainClient.getCertificate(tokenId);
      const cert: CertificateRecord = {
        certId,
        certType: "EVALUATION",
        sourceId: sub.id,
        tokenId,
        txHash: event?.txHash ?? "unknown",
        metadata: domainMetadata,
        metadataHash: onChainCert.metadataHash ?? metadataHash,
        revoked: onChainCert.revoked ?? false,
        createdAt: new Date().toISOString(),
      };
      await this.repo.createCertificate(cert);
      existingCert = cert;
    }

    sub.state = "FINALIZED";
    sub.mintStatus = "MINTED";
    sub.mintError = undefined;
    sub.certId = certId;
    sub.updatedAt = new Date().toISOString();
    await this.repo.updateSubmission(sub);

    return {
      status: 200,
      mintStatus: "MINTED",
      certificate: {
        certId,
        tokenId,
        txHash: existingCert.txHash ?? "unknown",
        verificationUrl: `/verify/${certId}`,
        emailStatus: "NOT_APPLICABLE",
      },
    };
  }
}
