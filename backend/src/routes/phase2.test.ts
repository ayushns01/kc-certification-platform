import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { buildTestApp, TEST_ADMIN_API_KEY, type TestHarness } from "../testSupport/buildTestApp";

const WORKSHOP_ID = "ws-201"; // seeded Phase-2 workshop

async function registerAndSubmit(harness: TestHarness, email = "meera@example.com") {
  const regRes = await request(harness.app)
    .post("/api/registrations")
    .send({ name: "Meera Iyer", email, workshopId: WORKSHOP_ID, phase: 2 });
  const registrationId = regRes.body.id;

  const subRes = await request(harness.app)
    .post("/api/submissions")
    .send({ registrationId, recordingUrl: "https://lms.example.com/rec/771.mp4" });

  return { regRes, subRes, registrationId, submissionId: subRes.body.id as string };
}

describe("Phase 2: submission -> evaluation -> finalize -> auto-mint", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = buildTestApp();
  });

  it("walks the full happy path and mints a certificate with ALL mandated metadata fields", async () => {
    const { subRes, submissionId } = await registerAndSubmit(harness);
    expect(subRes.status).toBe(201);
    expect(subRes.body.state).toBe("SUBMITTED");

    const evalRes = await request(harness.app)
      .put(`/api/admin/submissions/${submissionId}/evaluation`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({
        evaluatorName: "Guru Meenakshi",
        marks: 87,
        parameters: { rhythm: 9, expression: 8, technique: 9, repertoire: 8 },
        comments: "Strong laya control; abhinaya can deepen.",
        audioFeedbackUrl: "https://cdn.example.com/feedback/771.mp3",
      });
    expect(evalRes.status).toBe(200);
    expect(evalRes.body.state).toBe("EVALUATED");
    expect(evalRes.body.evaluation.grade).toBe("A"); // deriveGrade(87) === "A"

    const finalizeRes = await request(harness.app)
      .post(`/api/admin/submissions/${submissionId}/finalize`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();
    expect(finalizeRes.status).toBe(200);
    expect(finalizeRes.body.state).toBe("FINALIZED");
    const certId = finalizeRes.body.certificate.certId;
    expect(finalizeRes.body.certificate.txHash).toMatch(/^0x/);

    const metadataRes = await request(harness.app).get(`/api/metadata/${certId}`);
    expect(metadataRes.status).toBe(200);
    const kalachain = metadataRes.body.kalachain;

    // The full mandated Phase-2 field set (docs/REQUIREMENTS.md P2 metadata table).
    expect(kalachain.participantName).toBe("Meera Iyer");
    expect(kalachain.eventName).toBeTruthy();
    expect(kalachain.evaluatorName).toBe("Guru Meenakshi");
    expect(kalachain.marks).toBe(87);
    expect(kalachain.grade).toBe("A");
    expect(kalachain.parameters).toEqual({ rhythm: 9, expression: 8, technique: 9, repertoire: 8 });
    expect(kalachain.comments).toBe("Strong laya control; abhinaya can deepen.");
    expect(kalachain.audioFeedbackUrl).toBe("https://cdn.example.com/feedback/771.mp3");
    expect(kalachain.txHash).toMatch(/^0x/);

    // Also reachable by the numeric tokenId once minted.
    const byToken = await request(harness.app).get(`/api/metadata/${finalizeRes.body.certificate.tokenId}`);
    expect(byToken.status).toBe(200);
    expect(byToken.body.kalachain.certId).toBe(certId);
  });

  it("rejects a client-supplied grade (grade is server-derived only)", async () => {
    const { submissionId } = await registerAndSubmit(harness, "grade-hack@example.com");

    const res = await request(harness.app)
      .put(`/api/admin/submissions/${submissionId}/evaluation`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({
        evaluatorName: "Guru Meenakshi",
        marks: 40,
        grade: "A+", // client trying to force a top grade despite low marks
        parameters: { rhythm: 5 },
        comments: "needs work",
        audioFeedbackUrl: "https://cdn.example.com/feedback/1.mp3",
      });

    expect(res.status).toBe(400);
  });

  it("allows revising the evaluation draft before finalize, and rejects finalize before evaluation", async () => {
    const { submissionId } = await registerAndSubmit(harness, "revise@example.com");

    const finalizeBeforeEval = await request(harness.app)
      .post(`/api/admin/submissions/${submissionId}/finalize`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();
    expect(finalizeBeforeEval.status).toBe(409);
    expect(finalizeBeforeEval.body.currentState).toBe("SUBMITTED");

    await request(harness.app)
      .put(`/api/admin/submissions/${submissionId}/evaluation`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({
        evaluatorName: "Guru Meenakshi",
        marks: 55,
        parameters: { rhythm: 6 },
        comments: "draft 1",
        audioFeedbackUrl: "https://cdn.example.com/feedback/1.mp3",
      });

    const revised = await request(harness.app)
      .put(`/api/admin/submissions/${submissionId}/evaluation`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({
        evaluatorName: "Guru Meenakshi",
        marks: 91,
        parameters: { rhythm: 9 },
        comments: "draft 2 — much improved on review",
        audioFeedbackUrl: "https://cdn.example.com/feedback/2.mp3",
      });
    expect(revised.status).toBe(200);
    expect(revised.body.evaluation.grade).toBe("A+");
  });

  it("rejects finalize when already finalized (409)", async () => {
    const { submissionId } = await registerAndSubmit(harness, "double-finalize@example.com");
    await request(harness.app)
      .put(`/api/admin/submissions/${submissionId}/evaluation`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({
        evaluatorName: "Guru Meenakshi",
        marks: 75,
        parameters: { rhythm: 7 },
        comments: "solid",
        audioFeedbackUrl: "https://cdn.example.com/feedback/1.mp3",
      });
    await request(harness.app)
      .post(`/api/admin/submissions/${submissionId}/finalize`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();

    const second = await request(harness.app)
      .post(`/api/admin/submissions/${submissionId}/finalize`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();
    expect(second.status).toBe(409);
  });

  it("chain failure on finalize is honest (202 + FAILED) and retry succeeds", async () => {
    const { submissionId } = await registerAndSubmit(harness, "p2-chain-fail@example.com");
    await request(harness.app)
      .put(`/api/admin/submissions/${submissionId}/evaluation`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({
        evaluatorName: "Guru Meenakshi",
        marks: 82,
        parameters: { rhythm: 8 },
        comments: "good",
        audioFeedbackUrl: "https://cdn.example.com/feedback/1.mp3",
      });

    harness.chainClient.setFailNextMint(true);
    const finalizeRes = await request(harness.app)
      .post(`/api/admin/submissions/${submissionId}/finalize`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();
    expect(finalizeRes.status).toBe(202);
    expect(finalizeRes.body.mintStatus).toBe("FAILED");

    const retryRes = await request(harness.app)
      .post(`/api/admin/submissions/${submissionId}/retry-mint`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.state).toBe("FINALIZED");
  });
});
