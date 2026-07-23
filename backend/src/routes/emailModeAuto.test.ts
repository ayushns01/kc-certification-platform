import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Registration } from "../domain/types";
import { buildTestApp, TEST_ADMIN_API_KEY, type TestHarness } from "../testSupport/buildTestApp";

describe("EMAIL_MODE=auto", () => {
  let harness: TestHarness;

  beforeEach(() => {
    harness = buildTestApp({ emailMode: "auto" });
  });

  it("persists mintStatus=MINTED/emailStatus=PENDING BEFORE auto-dispatch fires, then flips to SENT", async () => {
    const regRes = await request(harness.app)
      .post("/api/registrations")
      .send({ name: "Auto Email", email: "auto-email@example.com", workshopId: "ws-101" });
    const registrationId = regRes.body.id;

    await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/payment`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send({ paymentRef: "ref", verifiedBy: "admin" });

    // Prove the spec-critical interleaving, not just the final state: capture
    // what the repo holds AT THE MOMENT dispatch is invoked. If a crash
    // happened right here, the record must already be an honest
    // MINTED/PENDING — mint itself never sends or pre-marks email.
    let repoStateWhenDispatchRan: Registration | undefined;
    const originalGet = harness.repo.getRegistration.bind(harness.repo);
    const dispatchSpy = vi
      .spyOn(harness.repo, "getRegistration")
      .mockImplementation(async (id: string) => {
        const reg = await originalGet(id);
        // EmailService.dispatch() re-reads the registration as its first step;
        // snapshot the persisted state the first time that happens post-mint.
        if (reg?.mintStatus === "MINTED" && !repoStateWhenDispatchRan) {
          repoStateWhenDispatchRan = { ...reg };
        }
        return reg;
      });

    const approveRes = await request(harness.app)
      .post(`/api/admin/registrations/${registrationId}/approve`)
      .set("x-api-key", TEST_ADMIN_API_KEY)
      .send();
    dispatchSpy.mockRestore();

    expect(approveRes.status).toBe(200);
    // Auto mode dispatches within the same call, so the response already
    // reflects the post-dispatch status...
    expect(approveRes.body.certificate.emailStatus).toBe("SENT");

    // ...and the snapshot proves the ordering: when dispatch first touched
    // the record, it was already persisted MINTED with email still PENDING.
    expect(repoStateWhenDispatchRan).toBeDefined();
    expect(repoStateWhenDispatchRan?.mintStatus).toBe("MINTED");
    expect(repoStateWhenDispatchRan?.emailStatus).toBe("PENDING");

    const stored = await harness.repo.getRegistration(registrationId);
    expect(stored?.mintStatus).toBe("MINTED");
    expect(stored?.emailStatus).toBe("SENT");
    expect(stored?.state).toBe("EMAIL_SENT");
  });
});
