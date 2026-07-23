/**
 * File-backed JSON repository — the zero-setup default for reviewers
 * (DATA_BACKEND=json). Seeds two workshops (one Phase-1, one Phase-2) on
 * first run. Writes are atomic (write to a temp file, then rename) so a
 * crash mid-write can never leave a half-written, corrupt store file.
 */
import { promises as fs } from "fs";
import path from "path";
import type {
  CertificateRecord,
  Registration,
  Submission,
  Workshop,
} from "../domain/types";
import type { IDataRepository } from "./types";
import { seedWorkshops } from "../data/seed";

interface StoreShape {
  workshops: Workshop[];
  registrations: Registration[];
  submissions: Submission[];
  certificates: CertificateRecord[];
}

function emptyStore(): StoreShape {
  return { workshops: [...seedWorkshops], registrations: [], submissions: [], certificates: [] };
}

export class MockJsonRepo implements IDataRepository {
  private store: StoreShape | null = null;
  private loadPromise: Promise<StoreShape> | null = null;

  constructor(private readonly filePath: string) {}

  private async ensureLoaded(): Promise<StoreShape> {
    if (this.store) return this.store;
    if (!this.loadPromise) {
      this.loadPromise = this.readOrSeed();
    }
    this.store = await this.loadPromise;
    return this.store;
  }

  private async readOrSeed(): Promise<StoreShape> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      return JSON.parse(raw) as StoreShape;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const seeded = emptyStore();
        await this.persist(seeded);
        return seeded;
      }
      throw err;
    }
  }

  private async persist(store: StoreShape): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(store, null, 2), "utf-8");
    await fs.rename(tmpPath, this.filePath);
  }

  private async save(): Promise<void> {
    if (!this.store) return;
    await this.persist(this.store);
  }

  // ---------- Workshops ----------
  async listWorkshops(): Promise<Workshop[]> {
    const store = await this.ensureLoaded();
    return [...store.workshops];
  }

  async getWorkshop(id: string): Promise<Workshop | undefined> {
    const store = await this.ensureLoaded();
    return store.workshops.find((w) => w.id === id);
  }

  // ---------- Registrations ----------
  async createRegistration(reg: Registration): Promise<void> {
    const store = await this.ensureLoaded();
    store.registrations.push(reg);
    await this.save();
  }

  async getRegistration(id: string): Promise<Registration | undefined> {
    const store = await this.ensureLoaded();
    return store.registrations.find((r) => r.id === id);
  }

  async findRegistration(email: string, workshopId: string): Promise<Registration | undefined> {
    const store = await this.ensureLoaded();
    const normalizedEmail = email.trim().toLowerCase();
    return store.registrations.find(
      (r) => r.email.toLowerCase() === normalizedEmail && r.workshopId === workshopId,
    );
  }

  async updateRegistration(reg: Registration): Promise<void> {
    const store = await this.ensureLoaded();
    const idx = store.registrations.findIndex((r) => r.id === reg.id);
    if (idx === -1) {
      store.registrations.push(reg);
    } else {
      store.registrations[idx] = reg;
    }
    await this.save();
  }

  async listRegistrations(filter?: { workshopId?: string; state?: string }): Promise<Registration[]> {
    const store = await this.ensureLoaded();
    return store.registrations.filter((r) => {
      if (filter?.workshopId && r.workshopId !== filter.workshopId) return false;
      if (filter?.state && r.state !== filter.state) return false;
      return true;
    });
  }

  // ---------- Submissions ----------
  async createSubmission(sub: Submission): Promise<void> {
    const store = await this.ensureLoaded();
    store.submissions.push(sub);
    await this.save();
  }

  async getSubmission(id: string): Promise<Submission | undefined> {
    const store = await this.ensureLoaded();
    return store.submissions.find((s) => s.id === id);
  }

  async updateSubmission(sub: Submission): Promise<void> {
    const store = await this.ensureLoaded();
    const idx = store.submissions.findIndex((s) => s.id === sub.id);
    if (idx === -1) {
      store.submissions.push(sub);
    } else {
      store.submissions[idx] = sub;
    }
    await this.save();
  }

  async listSubmissions(): Promise<Submission[]> {
    const store = await this.ensureLoaded();
    return [...store.submissions];
  }

  // ---------- Certificates ----------
  async createCertificate(cert: CertificateRecord): Promise<void> {
    const store = await this.ensureLoaded();
    store.certificates.push(cert);
    await this.save();
  }

  async getCertificate(certId: string): Promise<CertificateRecord | undefined> {
    const store = await this.ensureLoaded();
    return store.certificates.find((c) => c.certId === certId);
  }

  async getCertificateByTokenId(tokenId: number): Promise<CertificateRecord | undefined> {
    const store = await this.ensureLoaded();
    return store.certificates.find((c) => c.tokenId === tokenId);
  }

  async updateCertificate(cert: CertificateRecord): Promise<void> {
    const store = await this.ensureLoaded();
    const idx = store.certificates.findIndex((c) => c.certId === cert.certId);
    if (idx === -1) {
      store.certificates.push(cert);
    } else {
      store.certificates[idx] = cert;
    }
    await this.save();
  }

  async listCertificates(): Promise<CertificateRecord[]> {
    const store = await this.ensureLoaded();
    return [...store.certificates];
  }
}
