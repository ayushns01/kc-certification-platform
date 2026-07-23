/**
 * Builds the domain metadata that gets canonically hashed and anchored
 * on-chain, plus the public ERC-721 JSON shape served from
 * /api/metadata/:tokenId (the tokenURI target).
 *
 * Important: the transaction hash is NEVER part of the hashed domain
 * metadata. The tx hash is only known *after* the mint transaction confirms,
 * but the metadataHash committed on-chain has to be computed *before* the
 * mint call (it's one of the call's own arguments) — including txHash in the
 * hashed payload would be circular. The tx hash is attached to the stored
 * CertificateRecord after the receipt and surfaced separately (metadata
 * response + verification page), not folded into the hash anchor.
 */
import type { CertificateRecord, Registration, Submission, Workshop } from "../domain/types";

export interface ParticipationDomainMetadata {
  certId: string;
  certType: "PARTICIPATION";
  participantName: string;
  eventName: string;
  eventDate: string;
  [key: string]: unknown;
}

export interface EvaluationDomainMetadata {
  certId: string;
  certType: "EVALUATION";
  participantName: string;
  eventName: string;
  evaluatorName: string;
  marks: number;
  grade: string;
  parameters: Record<string, number>;
  comments: string;
  audioFeedbackUrl: string;
  [key: string]: unknown;
}

export function buildParticipationDomainMetadata(
  reg: Registration,
  workshop: Workshop,
  certId: string,
): ParticipationDomainMetadata {
  return {
    certId,
    certType: "PARTICIPATION",
    participantName: reg.name,
    eventName: workshop.name,
    eventDate: workshop.date,
  };
}

export function buildEvaluationDomainMetadata(
  sub: Submission,
  reg: Registration,
  workshop: Workshop,
  certId: string,
): EvaluationDomainMetadata {
  if (!sub.evaluation) {
    throw new Error(`Submission ${sub.id} has no evaluation to build metadata from`);
  }
  const evaluation = sub.evaluation;
  return {
    certId,
    certType: "EVALUATION",
    participantName: reg.name,
    eventName: workshop.name,
    evaluatorName: evaluation.evaluatorName,
    marks: evaluation.marks,
    grade: evaluation.grade,
    parameters: evaluation.parameters,
    comments: evaluation.comments,
    audioFeedbackUrl: evaluation.audioFeedbackUrl,
  };
}

/** ERC-721 metadata JSON shape (tokenURI target), with the full kalachain domain block. */
export function buildErc721Metadata(cert: CertificateRecord): Record<string, unknown> {
  const m = cert.metadata as Record<string, unknown>;
  const isEvaluation = cert.certType === "EVALUATION";

  const attributes: Array<{ trait_type: string; value: unknown }> = [
    { trait_type: "Certificate Type", value: cert.certType },
    { trait_type: "Participant", value: m.participantName },
    { trait_type: "Event", value: m.eventName },
  ];
  if (isEvaluation) {
    attributes.push(
      { trait_type: "Evaluator", value: m.evaluatorName },
      { trait_type: "Marks", value: m.marks },
      { trait_type: "Grade", value: m.grade },
    );
  }
  attributes.push({ trait_type: "Revoked", value: cert.revoked });

  return {
    name: `Kalachain ${isEvaluation ? "Evaluation" : "Participation"} Certificate`,
    description: `Soulbound certificate issued by Kalachain to ${m.participantName} for "${m.eventName}".`,
    attributes,
    kalachain: {
      certId: cert.certId,
      certType: cert.certType,
      tokenId: cert.tokenId,
      txHash: cert.txHash,
      metadataHash: cert.metadataHash,
      revoked: cert.revoked,
      revokeReason: cert.revokeReason,
      ...m,
    },
  };
}
