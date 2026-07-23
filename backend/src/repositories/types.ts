import type {
  CertificateRecord,
  Registration,
  Submission,
  Workshop,
} from "../domain/types";

/**
 * The single persistence interface. Two implementations:
 *  - MockJsonRepo   (DATA_BACKEND=json, default — zero-setup for reviewers)
 *  - GoogleSheetsRepo (DATA_BACKEND=sheets — the JD-aligned production path)
 *
 * Implementations MUST be safe for the sequential access pattern used by the
 * services (no concurrent-writer guarantees required beyond in-process).
 */
export interface IDataRepository {
  // Workshops
  listWorkshops(): Promise<Workshop[]>;
  getWorkshop(id: string): Promise<Workshop | undefined>;

  // Registrations (Phase 1 & Phase 2 registration records)
  createRegistration(reg: Registration): Promise<void>;
  getRegistration(id: string): Promise<Registration | undefined>;
  findRegistration(email: string, workshopId: string): Promise<Registration | undefined>;
  updateRegistration(reg: Registration): Promise<void>;
  listRegistrations(filter?: { workshopId?: string; state?: string }): Promise<Registration[]>;

  // Submissions (Phase 2)
  createSubmission(sub: Submission): Promise<void>;
  getSubmission(id: string): Promise<Submission | undefined>;
  updateSubmission(sub: Submission): Promise<void>;
  listSubmissions(): Promise<Submission[]>;

  // Certificates
  createCertificate(cert: CertificateRecord): Promise<void>;
  getCertificate(certId: string): Promise<CertificateRecord | undefined>;
  getCertificateByTokenId(tokenId: number): Promise<CertificateRecord | undefined>;
  updateCertificate(cert: CertificateRecord): Promise<void>;
  listCertificates(): Promise<CertificateRecord[]>;
}
