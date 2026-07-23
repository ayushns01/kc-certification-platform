/**
 * Startup reconciliation (X-8, crash-safe mint bookkeeping). The crash
 * window is: tx confirms on-chain -> process dies -> write-back to the repo
 * never happens. On boot, replay every `CertificateMinted` event and heal
 * any Registration/Submission that's stuck in MINTING/FAILED but was
 * actually minted on-chain. Chain is the source of truth for mint facts;
 * the repo is the source of truth for workflow state otherwise.
 */
import type { IChainClient, MintedEvent } from "../chain/types";
import type { CertificateRecord } from "../domain/types";
import type { IDataRepository } from "../repositories/types";
import type { Logger } from "../lib/logger";
import { recordIdFor } from "../lib/ids";
import { buildEvaluationDomainMetadata, buildParticipationDomainMetadata } from "./metadataService";

export interface ReconciliationSummary {
  healedRegistrations: number;
  healedSubmissions: number;
  totalEvents: number;
}

export async function reconcile(
  repo: IDataRepository,
  chainClient: IChainClient,
  logger: Logger,
): Promise<ReconciliationSummary> {
  const events = await chainClient.getMintedEvents();
  if (events.length === 0) {
    logger.info("reconciliation_no_events");
    return { healedRegistrations: 0, healedSubmissions: 0, totalEvents: 0 };
  }
  const byRecordId = new Map<string, MintedEvent>(events.map((e) => [e.recordId, e]));

  let healedRegistrations = 0;
  for (const reg of await repo.listRegistrations()) {
    if (!reg.certId || reg.mintStatus === "MINTED") continue;
    const event = byRecordId.get(recordIdFor(reg.certId));
    if (!event) continue;

    let cert = await repo.getCertificate(reg.certId);
    if (!cert) {
      const workshop = await repo.getWorkshop(reg.workshopId);
      const metadata = workshop
        ? buildParticipationDomainMetadata(reg, workshop, reg.certId)
        : { certId: reg.certId, participantName: reg.name };
      cert = {
        certId: reg.certId,
        certType: "PARTICIPATION",
        sourceId: reg.id,
        tokenId: event.tokenId,
        txHash: event.txHash,
        metadata,
        metadataHash: event.metadataHash,
        revoked: false,
        createdAt: new Date().toISOString(),
      } satisfies CertificateRecord;
      await repo.createCertificate(cert);
    }

    reg.state = "CERT_MINTED";
    reg.mintStatus = "MINTED";
    reg.mintError = undefined;
    if (reg.emailStatus !== "SENT") reg.emailStatus = "PENDING";
    reg.updatedAt = new Date().toISOString();
    await repo.updateRegistration(reg);
    healedRegistrations++;
    logger.warn("reconciliation_healed_registration", { registrationId: reg.id, tokenId: event.tokenId });
  }

  let healedSubmissions = 0;
  for (const sub of await repo.listSubmissions()) {
    if (!sub.certId || sub.mintStatus === "MINTED") continue;
    const event = byRecordId.get(recordIdFor(sub.certId));
    if (!event) continue;

    let cert = await repo.getCertificate(sub.certId);
    if (!cert) {
      const reg = await repo.getRegistration(sub.registrationId);
      const workshop = reg ? await repo.getWorkshop(reg.workshopId) : undefined;
      const metadata =
        reg && workshop && sub.evaluation
          ? buildEvaluationDomainMetadata(sub, reg, workshop, sub.certId)
          : { certId: sub.certId };
      cert = {
        certId: sub.certId,
        certType: "EVALUATION",
        sourceId: sub.id,
        tokenId: event.tokenId,
        txHash: event.txHash,
        metadata,
        metadataHash: event.metadataHash,
        revoked: false,
        createdAt: new Date().toISOString(),
      } satisfies CertificateRecord;
      await repo.createCertificate(cert);
    }

    sub.state = "FINALIZED";
    sub.mintStatus = "MINTED";
    sub.mintError = undefined;
    sub.updatedAt = new Date().toISOString();
    await repo.updateSubmission(sub);
    healedSubmissions++;
    logger.warn("reconciliation_healed_submission", { submissionId: sub.id, tokenId: event.tokenId });
  }

  const summary = { healedRegistrations, healedSubmissions, totalEvents: events.length };
  logger.info("reconciliation_complete", summary);
  return summary;
}
