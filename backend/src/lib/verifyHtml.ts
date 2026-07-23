/**
 * Minimal, self-contained (inline CSS, no external assets) HTML render for
 * the public /verify/:certId page.
 */
import type { VerificationResult } from "../services/verificationService";

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BADGE_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  VALID: { bg: "#16a34a", fg: "#ffffff", label: "VALID" },
  TAMPERED: { bg: "#dc2626", fg: "#ffffff", label: "TAMPERED" },
  REVOKED: { bg: "#d97706", fg: "#ffffff", label: "REVOKED" },
  NOT_FOUND: { bg: "#6b7280", fg: "#ffffff", label: "NOT FOUND" },
};

function renderMetadataRows(metadata?: Record<string, unknown>): string {
  if (!metadata) return "";
  return Object.entries(metadata)
    .map(
      ([key, value]) =>
        `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(
          typeof value === "object" ? JSON.stringify(value) : value,
        )}</td></tr>`,
    )
    .join("\n");
}

export function renderVerifyHtml(result: VerificationResult, certId: string): string {
  const badge = BADGE_STYLE[result.verdict];
  // explorerUrl is always a real URL when present; explorerNote carries the
  // no-public-explorer explanation on local networks.
  const explorerLink = result.explorerUrl
    ? `<a href="${escapeHtml(result.explorerUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(result.explorerUrl)}</a>`
    : escapeHtml(result.explorerNote ?? "");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Kalachain Certificate Verification — ${escapeHtml(certId)}</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 640px;
    margin: 3rem auto;
    padding: 0 1.5rem;
    color: #1f2937;
    background: #f9fafb;
  }
  @media (prefers-color-scheme: dark) {
    body { color: #e5e7eb; background: #111827; }
    table th { color: #9ca3af !important; }
    .card { background: #1f2937 !important; border-color: #374151 !important; }
  }
  h1 { font-size: 1.25rem; margin-bottom: 0.25rem; }
  .cert-id { color: #6b7280; font-size: 0.85rem; margin-bottom: 1.5rem; word-break: break-all; }
  .badge {
    display: inline-block;
    padding: 0.35rem 0.9rem;
    border-radius: 999px;
    font-weight: 700;
    letter-spacing: 0.03em;
    font-size: 0.85rem;
    background: ${badge.bg};
    color: ${badge.fg};
    margin-bottom: 1.5rem;
  }
  .card {
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 1rem;
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.4rem 0; vertical-align: top; }
  th { color: #6b7280; font-weight: 600; width: 40%; font-size: 0.85rem; }
  td { font-size: 0.9rem; word-break: break-word; }
  a { color: #2563eb; }
  footer { color: #9ca3af; font-size: 0.75rem; margin-top: 2rem; }
</style>
</head>
<body>
  <h1>Kalachain Certificate Verification</h1>
  <div class="cert-id">${escapeHtml(certId)}</div>
  <span class="badge">${badge.label}</span>

  ${
    result.verdict === "NOT_FOUND"
      ? `<div class="card">No certificate was found for this ID.</div>`
      : `<div class="card">
    <table>
      <tr><th>Certificate Type</th><td>${escapeHtml(result.certType ?? "—")}</td></tr>
      <tr><th>Token ID</th><td>${escapeHtml(result.tokenId ?? "—")}</td></tr>
      <tr><th>Transaction Hash</th><td>${escapeHtml(result.txHash ?? "—")}</td></tr>
      <tr><th>Explorer</th><td>${explorerLink || "—"}</td></tr>
      <tr><th>On-chain Hash</th><td>${escapeHtml(result.onChainHash ?? "—")}</td></tr>
      <tr><th>Recomputed Hash</th><td>${escapeHtml(result.recomputedHash ?? "—")}</td></tr>
    </table>
  </div>
  <div class="card">
    <table>
      ${renderMetadataRows(result.metadata)}
    </table>
  </div>`
  }

  <footer>Kalachain Certification Platform — soulbound on-chain credentials.</footer>
</body>
</html>`;
}
