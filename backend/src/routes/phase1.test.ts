import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { buildTestApp, TEST_ADMIN_API_KEY, type TestHarness } from "../testSupport/buildTestApp";
import { recordIdFor } from "../lib/ids";

const WORKSHOP_ID = "ws-101"; // seeded Phase-1 workshop

async function registerParticipant(harness: TestHarness, email = "asha@example.com") {
  const res = await request(harness.app)
    .post("/api/registrations")
    .send({ name: "Asha Rao", email, workshopId: WORKSHOP_ID });
  return res;
}

describe("Phase 1: registration -> payment -> approve -> auto-mint -> email dispatch", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = buildTestApp();
  });

  it("walks the full happy path: REGISTERED -> PAYMENT_VERIFIED -> CERT_MINTED, email PENDING then SENT", async () => {
    const regRes = await registerParticipant(harness);
    expect(regRes.status).toBe(201);
    expect(regRes.body.state).toBe("REGISTERED");
    const registrationId = regRes.body.id;

    const paymentRes = await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/payment`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({ paymentRef: "UPI-8842", verifiedBy: "admin@kalachain.org" });
    expect(paymentRes.status).toBe(200);
    expect(paymentRes.body.state).toBe("PAYMENT_VERIFIED");

    const approveRes = await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/approve`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.state).toBe("CERT_MINTED");
    expect(approveRes.body.certificate).toMatchObject({
      tokenId: 1,
      emailStatus: "PENDING",
    });
    expect(approveRes.body.certificate.certId).toMatch(/^cert_/);
    expect(approveRes.body.certificate.txHash).toMatch(/^0x/);
    expect(approveRes.body.certificate.verificationUrl).toBe(`/verify/${approveRes.body.certificate.certId}`);

    // Email must NOT have been sent by mint — dispatch is a separate, manual step.
    const stored = await harness.repo.getRegistration(registrationId);
    expect(stored?.emailStatus).toBe("PENDING");

    const dispatchRes = await request(harness.app)
      .post("/api/admin/emails/dispatch")
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({ registrationId });
    expect(dispatchRes.status).toBe(200);
    expect(dispatchRes.body).toEqual({ sent: 1, skipped: 0 });

    const afterDispatch = await harness.repo.getRegistration(registrationId);
    expect(afterDispatch?.emailStatus).toBe("SENT");
    expect(afterDispatch?.state).toBe("EMAIL_SENT");
  });

  it("rejects admin routes without a valid x-api-key", async () => {
    const regRes = await registerParticipant(harness);
    const res = await request(harness.app)
      .post(`/api/admin/registrations/${regRes.body.id}/payment`)
      .send({ paymentRef: "x", verifiedBy: "y" });
    expect(res.status).toBe(401);
  });

  it("rejects duplicate registration for the same email + workshop with 409", async () => {
    const first = await registerParticipant(harness, "dup@example.com");
    expect(first.status).toBe(201);
    const second = await registerParticipant(harness, "dup@example.com");
    expect(second.status).toBe(409);
  });

  it("rejects payment verification when not REGISTERED (409 with currentState)", async () => {
    const regRes = await registerParticipant(harness, "twice-paid@example.com");
    const registrationId = regRes.body.id;
    await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/payment`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({ paymentRef: "ref-1", verifiedBy: "admin" });

    const second = await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/payment`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({ paymentRef: "ref-2", verifiedBy: "admin" });

    expect(second.status).toBe(409);
    expect(second.body.currentState).toBe("PAYMENT_VERIFIED");
  });

  it("rejects approve when not PAYMENT_VERIFIED (409 with currentState)", async () => {
    const regRes = await registerParticipant(harness, "not-paid@example.com");
    const res = await request(harness.app)
      .post(`/api/admin/registrations/${regRes.body.id}/approve`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();
    expect(res.status).toBe(409);
    expect(res.body.currentState).toBe("REGISTERED");
  });

  it("rejects retry-mint when not APPROVED (409)", async () => {
    const regRes = await registerParticipant(harness, "no-retry@example.com");
    const res = await request(harness.app)
      .post(`/api/admin/registrations/${regRes.body.id}/retry-mint`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();
    expect(res.status).toBe(409);
    expect(res.body.currentState).toBe("REGISTERED");
  });

  it("handles chain failure honestly: 202 + APPROVED/FAILED, then retry succeeds", async () => {
    const regRes = await registerParticipant(harness, "chain-fail@example.com");
    const registrationId = regRes.body.id;
    await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/payment`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({ paymentRef: "ref", verifiedBy: "admin" });

    harness.chainClient.setFailNextMint(true);

    const approveRes = await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/approve`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();
    expect(approveRes.status).toBe(202);
    expect(approveRes.body.state).toBe("APPROVED");
    expect(approveRes.body.mintStatus).toBe("FAILED");
    expect(approveRes.body.retryUrl).toContain(registrationId);

    const stored = await harness.repo.getRegistration(registrationId);
    expect(stored?.state).toBe("APPROVED");
    expect(stored?.mintStatus).toBe("FAILED");
    expect(stored?.mintError).toBeTruthy();

    const retryRes = await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/retry-mint`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.state).toBe("CERT_MINTED");
    expect(retryRes.body.certificate.tokenId).toBe(1);
  });

  it("retry-mint after chain-already-minted heals the record without minting twice", async () => {
    const regRes = await registerParticipant(harness, "already-minted@example.com");
    const registrationId = regRes.body.id;
    await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/payment`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({ paymentRef: "ref", verifiedBy: "admin" });

    // Force the approve attempt to fail so the registration is left
    // APPROVED/FAILED with a certId already allocated.
    harness.chainClient.setFailNextMint(true);
    await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/approve`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();

    const stored = await harness.repo.getRegistration(registrationId);
    expect(stored?.certId).toBeTruthy();

    // Simulate the crash-recovery scenario directly: the chain actually DID
    // confirm a mint for this recordId (e.g. tx confirmed, then the process
    // died before the write-back), which our repo doesn't know about yet.
    const recordId = recordIdFor(stored!.certId!);
    await harness.chainClient.mintCertificate({
      to: "0x0000000000000000000000000000000000000001",
      certType: 0,
      uri: "https://example.com/ignored",
      metadataHash: "0x" + "1".repeat(64),
      recordId,
    });

    const mintSpy = vi.spyOn(harness.chainClient, "mintCertificate");

    const retryRes = await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/retry-mint`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.state).toBe("CERT_MINTED");
    // The heal path must NOT call mintCertificate again.
    expect(mintSpy).not.toHaveBeenCalled();

    const healed = await harness.repo.getRegistration(registrationId);
    expect(healed?.mintStatus).toBe("MINTED");
  });

  it("email dispatch is idempotent: second dispatch sends 0, skips 1", async () => {
    const regRes = await registerParticipant(harness, "idempotent-email@example.com");
    const registrationId = regRes.body.id;
    await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/payment`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({ paymentRef: "ref", verifiedBy: "admin" });
    await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/approve`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();

    const firstDispatch = await request(harness.app)
      .post("/api/admin/emails/dispatch")
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({ registrationId });
    expect(firstDispatch.body).toEqual({ sent: 1, skipped: 0 });

    const secondDispatch = await request(harness.app)
      .post("/api/admin/emails/dispatch")
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({ registrationId });
    expect(secondDispatch.body).toEqual({ sent: 0, skipped: 1 });
  });

  it("supports bulk email dispatch for a workshop", async () => {
    const a = await registerParticipant(harness, "bulk-a@example.com");
    const b = await registerParticipant(harness, "bulk-b@example.com");
    for (const regRes of [a, b]) {
      await request(harness.app)
        .post(`/api/admin/registrations/${regRes.body.id}/payment`)
        .set("x-api-key", TEST_ADMIN_API_KEY)
        .send({ paymentRef: "ref", verifiedBy: "admin" });
      await request(harness.app)
        .post(`/api/admin/registrations/${regRes.body.id}/approve`)
        .set("x-api-key", TEST_ADMIN_API_KEY)
        .send();
    }

    const bulkDispatch = await request(harness.app)
      .post("/api/admin/emails/dispatch")
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({ workshopId: WORKSHOP_ID });
    expect(bulkDispatch.body.sent).toBeGreaterThanOrEqual(2);
  });

  it("lists seeded workshops", async () => {
    const res = await request(harness.app).get("/api/workshops");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    expect(res.body.some((w: { id: string }) => w.id === "ws-101")).toBe(true);
  });
});
