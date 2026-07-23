import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { buildTestApp, TEST_ADMIN_API_KEY, type TestHarness } from "../testSupport/buildTestApp";

async function mintOneCertificate(harness: TestHarness): Promise<string> {
  const regRes = await request(harness.app)
    .post("/api/registrations")
    .send({ name: "Tamper Test", email: "tamper@example.com", workshopId: "ws-101" });
  const registrationId = regRes.body.id;
  await request(harness.app)
    .post(`/api/admin/registrations/${registrationId}/payment`)
    .set("x-api-key", TEST_ADMIN_API_KEY)
    .send({ paymentRef: "ref", verifiedBy: "admin" });
  const approveRes = await request(harness.app)
    .post(`/api/admin/registrations/${registrationId}/approve`)
    .set("x-api-key", TEST_ADMIN_API_KEY)
    .send();
  return approveRes.body.certificate.certId as string;
}

describe("GET /verify/:certId", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = buildTestApp();
  });

  it("returns NOT_FOUND for an unknown certId", async () => {
    const res = await request(harness.app).get("/verify/cert_doesnotexist").set("Accept", "application/json");
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("NOT_FOUND");
  });

  it("returns VALID for an untampered certificate, with tokenId/txHash/explorer info", async () => {
    const certId = await mintOneCertificate(harness);
    const res = await request(harness.app).get(`/verify/${certId}`).set("Accept", "application/json");
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("VALID");
    expect(res.body.tokenId).toBe(1);
    expect(res.body.txHash).toMatch(/^0x/);
    expect(res.body.onChainHash).toBe(res.body.recomputedHash);
  });

  it("flips to TAMPERED when stored metadata is mutated after mint", async () => {
    const certId = await mintOneCertificate(harness);

    const cert = await harness.repo.getCertificate(certId);
    expect(cert).toBeDefined();
    cert!.metadata.participantName = "Someone Else Entirely";
    await harness.repo.updateCertificate(cert!);

    const res = await request(harness.app).get(`/verify/${certId}`).set("Accept", "application/json");
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("TAMPERED");
    expect(res.body.onChainHash).not.toBe(res.body.recomputedHash);
  });

  it("serves a self-contained HTML page by default", async () => {
    const certId = await mintOneCertificate(harness);
    const res = await request(harness.app).get(`/verify/${certId}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("html");
    expect(res.text).toContain("VALID");
    expect(res.text).toContain("<html");
  });

  it("returns REVOKED after the issuer revokes the token (JSON and HTML badge)", async () => {
    const certId = await mintOneCertificate(harness);
    await harness.chainClient.revoke(1, "issued in error");

    const jsonRes = await request(harness.app).get(`/verify/${certId}`).set("Accept", "application/json");
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.body.verdict).toBe("REVOKED");

    const htmlRes = await request(harness.app).get(`/verify/${certId}`);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.text).toContain("REVOKED");
  });

  it("returns NOT_FOUND when the record's token does not exist on-chain", async () => {
    const certId = await mintOneCertificate(harness);

    // Simulate a record pointing at a token the chain has no knowledge of.
    const cert = await harness.repo.getCertificate(certId);
    cert!.tokenId = 999;
    await harness.repo.updateCertificate(cert!);

    const res = await request(harness.app).get(`/verify/${certId}`).set("Accept", "application/json");
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe("NOT_FOUND");
  });

  it("returns 503 (never a verdict) when the chain cannot be queried", async () => {
    const certId = await mintOneCertificate(harness);
    harness.chainClient.setChainDown(true);

    const res = await request(harness.app).get(`/verify/${certId}`).set("Accept", "application/json");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("chain unavailable");
    expect(res.body.verdict).toBeUndefined();

    // Chain restored → verification works again, proving the 503 was honest, not sticky.
    harness.chainClient.setChainDown(false);
    const recovered = await request(harness.app).get(`/verify/${certId}`).set("Accept", "application/json");
    expect(recovered.body.verdict).toBe("VALID");
  });
});
