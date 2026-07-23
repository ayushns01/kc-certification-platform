/**
 * Manual payment verification (P1-2). Only valid from REGISTERED.
 */
import { z } from "zod";
import type { Registration } from "../domain/types";
import type { IDataRepository } from "../repositories/types";
import { IllegalTransitionError, NotFoundError } from "../domain/errors";

const paymentSchema = z.object({
  paymentRef: z.string().trim().min(1, "paymentRef is required"),
  verifiedBy: z.string().trim().min(1, "verifiedBy is required"),
});

export class PaymentService {
  constructor(private readonly repo: IDataRepository) {}

  async recordPayment(registrationId: string, input: unknown): Promise<Registration> {
    const parsed = paymentSchema.parse(input);

    const reg = await this.repo.getRegistration(registrationId);
    if (!reg) {
      throw new NotFoundError(`Unknown registration: ${registrationId}`);
    }
    if (reg.state !== "REGISTERED") {
      throw new IllegalTransitionError(
        reg.state,
        `Cannot record payment: registration ${registrationId} is ${reg.state}, expected REGISTERED`,
      );
    }

    reg.paymentRef = parsed.paymentRef;
    reg.paymentVerifiedBy = parsed.verifiedBy;
    reg.state = "PAYMENT_VERIFIED";
    reg.updatedAt = new Date().toISOString();
    await this.repo.updateRegistration(reg);
    return reg;
  }
}
