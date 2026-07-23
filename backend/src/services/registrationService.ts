/**
 * Phase-1/Phase-2 registration creation (P1-1, P2-1 precondition). Validates
 * input, resolves phase from the workshop when not supplied, and guards
 * against duplicate registration (same email + workshop).
 */
import { z } from "zod";
import type { Registration } from "../domain/types";
import type { IDataRepository } from "../repositories/types";
import { ConflictError, NotFoundError } from "../domain/errors";
import { generateRegistrationId } from "../lib/ids";

const registrationSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
  email: z.string().trim().email("email must be a valid email address"),
  workshopId: z.string().trim().min(1, "workshopId is required"),
  phase: z.union([z.literal(1), z.literal(2)]).optional(),
});

export class RegistrationService {
  constructor(private readonly repo: IDataRepository) {}

  async register(input: unknown): Promise<Registration> {
    const parsed = registrationSchema.parse(input);

    const workshop = await this.repo.getWorkshop(parsed.workshopId);
    if (!workshop) {
      throw new NotFoundError(`Unknown workshop: ${parsed.workshopId}`);
    }

    const normalizedEmail = parsed.email.toLowerCase();
    const existing = await this.repo.findRegistration(normalizedEmail, parsed.workshopId);
    if (existing) {
      throw new ConflictError(
        `A registration already exists for ${normalizedEmail} in workshop ${parsed.workshopId}`,
      );
    }

    const now = new Date().toISOString();
    const registration: Registration = {
      id: generateRegistrationId(),
      workshopId: parsed.workshopId,
      name: parsed.name,
      email: normalizedEmail,
      phase: parsed.phase ?? workshop.phase,
      state: "REGISTERED",
      mintStatus: "NONE",
      emailStatus: "NOT_APPLICABLE",
      createdAt: now,
      updatedAt: now,
    };

    await this.repo.createRegistration(registration);
    return registration;
  }
}
