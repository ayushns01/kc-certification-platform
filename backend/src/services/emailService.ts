/**
 * Manual (or EMAIL_MODE=auto) email dispatch. Mint NEVER sends email itself
 * — see approvalService/submissionService, which always leave emailStatus
 * PENDING at mint time. Dispatch here is the only thing that sends mail and
 * flips PENDING -> SENT, and it is idempotent: anything not currently
 * PENDING is skipped, so re-dispatching (single or bulk) never double-sends.
 *
 * If SMTP is not configured, falls back to nodemailer's JSON transport (a
 * stub that "sends" by serializing the message instead of hitting a real
 * server) so the whole flow is demoable without any mail infrastructure.
 */
import nodemailer, { type Transporter } from "nodemailer";
import type { AppConfig } from "../config";
import type { Registration } from "../domain/types";
import type { IDataRepository } from "../repositories/types";
import type { Logger } from "../lib/logger";
import { NotFoundError } from "../domain/errors";

export interface DispatchSummary {
  sent: number;
  skipped: number;
}

export class EmailService {
  private readonly transporter: Transporter;

  constructor(
    private readonly repo: IDataRepository,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.transporter = config.smtpHost
      ? nodemailer.createTransport({
          host: config.smtpHost,
          port: config.smtpPort ?? 587,
          auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
        })
      : nodemailer.createTransport({ jsonTransport: true });
  }

  private buildMessage(reg: Registration) {
    const verificationUrl = `${this.config.baseUrl}/verify/${reg.certId}`;
    return {
      from: this.config.emailFrom,
      to: reg.email,
      subject: "Your Kalachain certificate is ready",
      text:
        `Hi ${reg.name},\n\n` +
        `Your certificate has been issued. You can verify it any time at:\n${verificationUrl}\n\n` +
        `— Kalachain`,
    };
  }

  /** Dispatch to a single registration. Idempotent: skips anything not PENDING. */
  async dispatch(registrationId: string): Promise<DispatchSummary> {
    const reg = await this.repo.getRegistration(registrationId);
    if (!reg) throw new NotFoundError(`Unknown registration: ${registrationId}`);
    if (reg.emailStatus !== "PENDING") {
      return { sent: 0, skipped: 1 };
    }
    return this.sendAndMark(reg);
  }

  /** Bulk dispatch: all PENDING registrations for a workshop. Idempotent per-registration. */
  async dispatchAll(workshopId: string): Promise<DispatchSummary> {
    const regs = await this.repo.listRegistrations({ workshopId });
    const summary: DispatchSummary = { sent: 0, skipped: 0 };
    for (const reg of regs) {
      if (reg.emailStatus !== "PENDING") {
        summary.skipped += 1;
        continue;
      }
      const result = await this.sendAndMark(reg);
      summary.sent += result.sent;
      summary.skipped += result.skipped;
    }
    return summary;
  }

  private async sendAndMark(reg: Registration): Promise<DispatchSummary> {
    try {
      await this.transporter.sendMail(this.buildMessage(reg));
      reg.emailStatus = "SENT";
      if (reg.state === "CERT_MINTED") reg.state = "EMAIL_SENT";
      reg.updatedAt = new Date().toISOString();
      await this.repo.updateRegistration(reg);
      this.logger.info("email_sent", { registrationId: reg.id, email: reg.email });
      return { sent: 1, skipped: 0 };
    } catch (err) {
      // Leaves emailStatus PENDING so a later dispatch call can safely retry.
      this.logger.error("email_send_failed", { registrationId: reg.id, err });
      return { sent: 0, skipped: 1 };
    }
  }
}
