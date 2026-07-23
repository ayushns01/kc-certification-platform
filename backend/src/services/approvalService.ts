/**
 * Phase-1 approval + auto-mint (P1-3, P1-4 — hard requirement). `approve()`
 * transitions PAYMENT_VERIFIED -> APPROVED and, in the SAME operation,
 * mints the participation certificate. The APPROVED+MINTING state is
 * persisted BEFORE the chain call so a crash mid-mint leaves an honest,
 * retryable record rather than losing the fact that approval happened.
 *
 * Mint failure never fakes success: the registration stays APPROVED with
 * mintStatus=FAILED + mintError, and the API returns 202 with a retry URL.
 * retryMint() is idempotent — it first asks the chain whether this record
 * was already minted (crash-recovery: tx confirmed, then the process died
 * before the write-back landed) and heals instead of re-minting if so.
 */
import type { AppConfig } from "../config";
import type { IChainClient, MintedEvent } from "../chain/types";
import type { CertificateRecord, EmailStatus, Registration, Workshop } from "../domain/types";
import type { IDataRepository } from "../repositories/types";
import { IllegalTransitionError, NotFoundError } from "../domain/errors";
import { generateCertId, recordIdFor } from "../lib/ids";
import { buildParticipationDomainMetadata } from "./metadataService";
import { canonicalHash } from "../lib/canonicalHash";
import { checkAlreadyMinted, performMint, type MintOutcome } from "./mintingCore";
import type { EmailService } from "./emailService";

export class ApprovalService {
  constructor(
    private readonly repo: IDataRepository,
    private readonly chainClient: IChainClient,
    private readonly config: AppConfig,
    private readonly emailService: EmailService,
  ) {}

  async approve(registrationId: string): Promise<MintOutcome> {
    const reg = await this.repo.getRegistration(registrationId);
    if (!reg) throw new NotFoundError(`Unknown registration: ${registrationId}`);
    if (reg.state !== "PAYMENT_VERIFIED") {
      throw new IllegalTransitionError(
        reg.state,
        `Cannot approve: registration ${registrationId} is ${reg.state}, expected PAYMENT_VERIFIED`,
      );
    }

    const workshop = await this.repo.getWorkshop(reg.workshopId);
    if (!workshop) throw new NotFoundError(`Workshop ${reg.workshopId} not found`);

    const certId = generateCertId();
    reg.state = "APPROVED";
    reg.mintStatus = "MINTING";
    reg.certId = certId;
    reg.updatedAt = new Date().toISOString();
    await this.repo.updateRegistration(reg);

    return this.mintFor(reg, workshop, certId);
  }

  async retryMint(registrationId: string): Promise<MintOutcome> {
    const reg = await this.repo.getRegistration(registrationId);
    if (!reg) throw new NotFoundError(`Unknown registration: ${registrationId}`);
    if (reg.state === "CERT_MINTED" || reg.state === "EMAIL_SENT") {
      throw new IllegalTransitionError(reg.state, `Registration ${registrationId} is already minted`);
    }
    if (reg.state !== "APPROVED") {
      throw new IllegalTransitionError(
        reg.state,
        `Cannot retry mint: registration ${registrationId} is ${reg.state}, expected APPROVED`,
      );
    }

    const workshop = await this.repo.getWorkshop(reg.workshopId);
    if (!workshop) throw new NotFoundError(`Workshop ${reg.workshopId} not found`);

    const certId = reg.certId ?? generateCertId();

    const alreadyMinted = await checkAlreadyMinted(this.chainClient, certId);
    if (alreadyMinted) {
      return this.healAlreadyMinted(reg, workshop, certId, alreadyMinted.tokenId);
    }

    reg.mintStatus = "MINTING";
    reg.certId = certId;
    reg.updatedAt = new Date().toISOString();
    await this.repo.updateRegistration(reg);

    return this.mintFor(reg, workshop, certId);
  }

  private async mintFor(reg: Registration, workshop: Workshop, certId: string): Promise<MintOutcome> {
    const domainMetadata = buildParticipationDomainMetadata(reg, workshop, certId);

    return performMint({
      repo: this.repo,
      chainClient: this.chainClient,
      config: this.config,
      certId,
      certType: 0,
      sourceId: reg.id,
      domainMetadata,
      recipientEmail: reg.email,
      retryUrl: `/api/admin/registrations/${reg.id}/retry-mint`,
      onFailure: async (mintError) => {
        reg.mintStatus = "FAILED";
        reg.mintError = mintError;
        reg.updatedAt = new Date().toISOString();
        await this.repo.updateRegistration(reg);
      },
      onSuccess: async (result) => {
        reg.state = "CERT_MINTED";
        reg.mintStatus = "MINTED";
        reg.mintError = undefined;
        reg.emailStatus = "PENDING";
        reg.updatedAt = new Date().toISOString();
        // Persist the mint-succeeded + email-pending state BEFORE any
        // auto-dispatch, so a crash between mint and dispatch can never
        // lose the fact that the certificate was minted.
        await this.repo.updateRegistration(reg);

        if (this.config.emailMode === "auto") {
          await this.emailService.dispatch(reg.id);
          const refreshed = await this.repo.getRegistration(reg.id);
          return refreshed?.emailStatus ?? "PENDING";
        }
        return "PENDING" as EmailStatus;
      },
    });
  }

  private async healAlreadyMinted(
    reg: Registration,
    workshop: Workshop,
    certId: string,
    tokenId: number,
  ): Promise<MintOutcome> {
    const domainMetadata = buildParticipationDomainMetadata(reg, workshop, certId);
    const metadataHash = canonicalHash(domainMetadata);
    const recordId = recordIdFor(certId);

    let existingCert = await this.repo.getCertificate(certId);
    if (!existingCert) {
      const events: MintedEvent[] = await this.chainClient.getMintedEvents();
      const event = events.find((e) => e.recordId === recordId);
      const onChainCert = await this.chainClient.getCertificate(tokenId);
      const cert: CertificateRecord = {
        certId,
        certType: "PARTICIPATION",
        sourceId: reg.id,
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

    reg.state = "CERT_MINTED";
    reg.mintStatus = "MINTED";
    reg.mintError = undefined;
    reg.certId = certId;
    if (reg.emailStatus !== "SENT") reg.emailStatus = "PENDING";
    reg.updatedAt = new Date().toISOString();
    await this.repo.updateRegistration(reg);

    return {
      status: 200,
      mintStatus: "MINTED",
      certificate: {
        certId,
        tokenId,
        txHash: existingCert.txHash ?? "unknown",
        verificationUrl: `/verify/${certId}`,
        emailStatus: reg.emailStatus,
      },
    };
  }
}
