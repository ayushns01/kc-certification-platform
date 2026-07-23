/**
 * Shared mint-and-record logic used by both approvalService (Phase 1) and
 * submissionService (Phase 2). Both flows follow the exact same shape:
 * build domain metadata → canonical hash → mint on-chain → on success,
 * persist a CertificateRecord and hand back a MintOutcome; on failure, let
 * the caller persist FAILED + the error onto its own record (Registration
 * or Submission) and return a 202/retryable outcome. Centralizing this
 * avoids the two services silently drifting on failure semantics.
 */
import type { AppConfig } from "../config";
import type { CertificateRecord, CertType, EmailStatus } from "../domain/types";
import type { IChainClient, MintResult } from "../chain/types";
import type { IDataRepository } from "../repositories/types";
import { canonicalHash } from "../lib/canonicalHash";
import { deriveCustodialAddress } from "../lib/custodialAddress";
import { recordIdFor } from "../lib/ids";

export interface MintOutcome {
  status: 200 | 202;
  mintStatus: "MINTED" | "FAILED";
  mintError?: string;
  certificate?: {
    certId: string;
    tokenId: number;
    txHash: string;
    verificationUrl: string;
    emailStatus: EmailStatus;
  };
  retryUrl?: string;
}

export interface PerformMintParams {
  repo: IDataRepository;
  chainClient: IChainClient;
  config: AppConfig;
  certId: string;
  certType: 0 | 1;
  sourceId: string;
  domainMetadata: Record<string, unknown>;
  recipientEmail: string;
  retryUrl: string;
  /** Persist mintStatus=FAILED + mintError on the owning record (Registration/Submission). */
  onFailure: (mintError: string) => Promise<void>;
  /** Persist the success state on the owning record; returns the final emailStatus (post any auto-dispatch). */
  onSuccess: (result: MintResult, cert: CertificateRecord) => Promise<EmailStatus>;
}

const CERT_TYPE_NAME: Record<0 | 1, CertType> = {
  0: "PARTICIPATION",
  1: "EVALUATION",
};

export async function performMint(params: PerformMintParams): Promise<MintOutcome> {
  const recordId = recordIdFor(params.certId);
  const metadataHash = canonicalHash(params.domainMetadata);
  const uri = `${params.config.baseUrl}/api/metadata/${params.certId}`;
  const to = deriveCustodialAddress(params.recipientEmail);

  try {
    const result = await params.chainClient.mintCertificate({
      to,
      certType: params.certType,
      uri,
      metadataHash,
      recordId,
    });

    const cert: CertificateRecord = {
      certId: params.certId,
      certType: CERT_TYPE_NAME[params.certType],
      sourceId: params.sourceId,
      tokenId: result.tokenId,
      txHash: result.txHash,
      metadata: params.domainMetadata,
      metadataHash,
      revoked: false,
      createdAt: new Date().toISOString(),
    };
    await params.repo.createCertificate(cert);

    const emailStatus = await params.onSuccess(result, cert);

    return {
      status: 200,
      mintStatus: "MINTED",
      certificate: {
        certId: params.certId,
        tokenId: result.tokenId,
        txHash: result.txHash,
        verificationUrl: `/verify/${params.certId}`,
        emailStatus,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await params.onFailure(message);
    return { status: 202, mintStatus: "FAILED", mintError: message, retryUrl: params.retryUrl };
  }
}

/** Checks whether the chain already has a mint for this certId (crash-recovery heal path). */
export async function checkAlreadyMinted(
  chainClient: IChainClient,
  certId: string,
): Promise<{ tokenId: number; recordId: string } | null> {
  const recordId = recordIdFor(certId);
  const tokenId = await chainClient.mintedFor(recordId);
  return tokenId > 0 ? { tokenId, recordId } : null;
}
