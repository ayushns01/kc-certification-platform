/**
 * Core domain types — the single source of truth for workflow state.
 * All state transitions go through service methods; illegal transitions → 409.
 */

// ---------- Phase 1: participation lifecycle ----------
export type ParticipantState =
  | "REGISTERED"
  | "PAYMENT_VERIFIED"
  | "APPROVED"
  | "CERT_MINTED"
  | "EMAIL_SENT";

// ---------- Phase 2: evaluation lifecycle ----------
export type SubmissionState = "SUBMITTED" | "EVALUATED" | "FINALIZED";

export type MintStatus = "NONE" | "MINTING" | "MINTED" | "FAILED";
export type EmailStatus = "NOT_APPLICABLE" | "PENDING" | "SENT";
export type CertType = "PARTICIPATION" | "EVALUATION";
export type Phase = 1 | 2;

export interface Workshop {
  id: string;
  name: string;
  date: string; // ISO
  phase: Phase;
}

export interface Registration {
  id: string;
  workshopId: string;
  name: string;
  email: string;
  phase: Phase;
  state: ParticipantState;
  paymentRef?: string;
  paymentVerifiedBy?: string;
  mintStatus: MintStatus;
  mintError?: string;
  emailStatus: EmailStatus;
  certId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Submission {
  id: string;
  registrationId: string;
  recordingUrl: string;
  state: SubmissionState;
  evaluation?: Evaluation;
  mintStatus: MintStatus;
  mintError?: string;
  certId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Evaluation {
  evaluatorName: string;
  marks: number; // 0–100
  grade: string; // derived server-side, never client-supplied
  parameters: Record<string, number>; // e.g. { rhythm: 9, expression: 8 }
  comments: string;
  audioFeedbackUrl: string;
}

export interface CertificateRecord {
  certId: string; // stable public ID used in /verify/:certId
  certType: CertType;
  sourceId: string; // registrationId (P1) or submissionId (P2)
  tokenId?: number;
  txHash?: string;
  metadata: Record<string, unknown>; // canonical domain metadata (hashed)
  metadataHash: string; // 0x-prefixed keccak256 of canonicalized metadata
  revoked: boolean;
  revokeReason?: string;
  createdAt: string;
}

/** Deterministic grade derivation — the ONLY place grades come from. */
export function deriveGrade(marks: number): string {
  if (marks >= 90) return "A+";
  if (marks >= 80) return "A";
  if (marks >= 70) return "B+";
  if (marks >= 60) return "B";
  if (marks >= 50) return "C";
  return "F";
}
