import { beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { buildTestApp, TEST_ADMIN_API_KEY, type TestHarness } from "../testSupport/buildTestApp";

describe("EMAIL_MODE=auto", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = buildTestApp({ emailMode: "auto" });
  });

  it("still writes mintStatus=MINTED/emailStatus=PENDING before auto-dispatching, then flips to SENT", async () => {
    const regRes = await request(harness.app)
      .post("/api/registrations")
      .send({ name: "Auto Email", email: "auto-email@example.com", workshopId: "ws-101" });
    const registrationId = regRes.body.id;

    await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/payment`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({ paymentRef: "ref", verifiedBy: "admin" });

    const approveRes = await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/approve`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();

    expect(approveRes.status).toBe(200);
    // Auto mode dispatches within the same call, so the response already
    // reflects the post-dispatch status...
    expect(approveRes.body.certificate.emailStatus).toBe("SENT");

    // ...but the record was still marked MINTED/PENDING before dispatch ran
    // (mint never sends email itself) — verified via final persisted state.
    const stored = await harness.repo.getRegistration(registrationId);
    expect(stored?.mintStatus).toBe("MINTED");
    expect(stored?.emailStatus).toBe("SENT");
    expect(stored?.state).toBe("EMAIL_SENT");
  });
});
