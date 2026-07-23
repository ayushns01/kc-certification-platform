import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, vi } from "vitest";
import { MockJsonRepo } from "../repositories/mockJsonRepo";
import { FakeChainClient } from "../chain/fakeChainClient";
import { RegistrationService } from "../services/registrationService";
import { PaymentService } from "../services/paymentService";
import { ApprovalService } from "../services/approvalService";
import { EmailService } from "../services/emailService";
import { buildTestConfig } from "../testSupport/buildTestApp";
import { buildWorkflowActions } from "./workflowActionsAdapter";

/** Real services + fake chain — verifies the adapter's mapping logic, the
 * seam the sheets spec review flagged as untested. */
function buildHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kalachain-adapter-"));
  const repo = new MockJsonRepo(path.join(tmpDir, "store.local.json"));
  const chainClient = new FakeChainClient();
  const config = buildTestConfig();
  const noop = () => undefined;
  const logger = { debug: noop, info: noop, warn: noop, error: noop };
  const emailService = new EmailService(repo, config, logger);
  const paymentService = new PaymentService(repo);
  const approvalService = new ApprovalService(repo, chainClient, config, emailService);
  const registrationService = new RegistrationService(repo);
  const actions = buildWorkflowActions({ repo, paymentService, approvalService, emailService });
  return { repo, chainClient, registrationService, actions };
}

async function registered(h: ReturnType<typeof buildHarness>, email: string): Promise<string> {
  const reg = await h.registrationService.register({ name: "Sheet Admin Demo", email, workshopId: "ws-101" });
  return reg.id;
}

describe("workflowActionsAdapter (worker <-> services seam)", () => {
  it("drives the full sheet-command sequence: VERIFY_PAYMENT -> APPROVE -> SEND", async () => {
    const h = buildHarness();
    const regId = await registered(h, "adapter-happy@example.com");

    await h.actions.recordPayment(regId, "UPI-77", "sheet-admin");
    expect((await h.repo.getRegistration(regId))?.state).toBe("PAYMENT_VERIFIED");

    const outcome = await h.actions.approveAndMint(regId);
    expect(outcome.mintStatus).toBe("MINTED");
    expect(outcome.certId).toMatch(/^cert_/);
    expect(outcome.txHash).toMatch(/^0x/);
    expect(outcome.tokenId).toBe(1);
    expect(outcome.verificationUrl).toBe(`/verify/${outcome.certId}`);
    // Mint never sends email — PENDING until the SEND command.
    expect((await h.repo.getRegistration(regId))?.emailStatus).toBe("PENDING");

    await h.actions.dispatchEmail(regId);
    expect((await h.repo.getRegistration(regId))?.emailStatus).toBe("SENT");
    // A second SEND has nothing to dispatch — surfaced as an error, not a silent SENT.
    await expect(h.actions.dispatchEmail(regId)).rejects.toThrow(/not in a dispatchable/);
  });

  it("maps a re-entered APPROVE after a failed mint to retry-mint (no 409, no double-mint)", async () => {
    const h = buildHarness();
    const regId = await registered(h, "adapter-retry@example.com");
    await h.actions.recordPayment(regId, "UPI-78", "sheet-admin");

    h.chainClient.setFailNextMint(true);
    const failed = await h.actions.approveAndMint(regId);
    expect(failed.mintStatus).toBe("FAILED");
    expect(failed.error).toBeTruthy();
    expect((await h.repo.getRegistration(regId))?.state).toBe("APPROVED");

    // The admin re-enters APPROVE; the adapter must route to retryMint.
    const mintSpy = vi.spyOn(h.chainClient, "mintCertificate");
    const retried = await h.actions.approveAndMint(regId);
    expect(retried.mintStatus).toBe("MINTED");
    expect(mintSpy).toHaveBeenCalledTimes(1); // exactly one more mint, same certId
    expect(retried.certId).toBe((await h.repo.getRegistration(regId))?.certId);
  });

  it("rejects APPROVE on a row that is neither PAYMENT_VERIFIED nor APPROVED", async () => {
    const h = buildHarness();
    const regId = await registered(h, "adapter-illegal@example.com");
    await expect(h.actions.approveAndMint(regId)).rejects.toThrow(/expected PAYMENT_VERIFIED/);
  });
});
