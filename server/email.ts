import nodemailer from "nodemailer";
import { storage } from "./storage";
import { escapeMarkup } from "./outputEncoding";

function getTransport() {
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT ?? "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

export async function sendGitCommitFailureEmail(opts: {
  to: string;
  receiptId: number | string;
  entryHash: string;
  errorMessage: string;
  baseUrl: string;
}): Promise<void> {
  const settingsUrl = `${opts.baseUrl}/dashboard#github`;

  const text = [
    "A ForgeProof attestation could not be committed to your GitHub repository.",
    "",
    `  Receipt ID : ${opts.receiptId}`,
    `  Entry hash : ${opts.entryHash}`,
    `  Reason     : ${opts.errorMessage}`,
    "",
    "This usually means your GitHub token has expired or been revoked.",
    "Re-connect your GitHub account to restore automatic provenance commits:",
    "",
    `  ${settingsUrl}`,
    "",
    "Your attestation receipt has still been saved in ForgeProof — only the",
    "GitHub commit failed.  You can retry the commit from the receipt detail page",
    "once your token is refreshed.",
    "",
    "— The ForgeProof Team",
  ].join("\n");

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;color:#1a1a2e;max-width:600px;margin:40px auto;padding:0 16px">
  <h2 style="color:#2563eb">ForgeProof — GitHub commit failed</h2>
  <p>A ForgeProof attestation could not be committed to your GitHub repository.</p>
  <table style="border-collapse:collapse;width:100%;margin:16px 0">
    <tr><td style="padding:6px 12px;background:#f1f5f9;font-weight:600;width:130px">Receipt ID</td><td style="padding:6px 12px;background:#f8fafc">${escapeMarkup(opts.receiptId)}</td></tr>
    <tr><td style="padding:6px 12px;background:#f1f5f9;font-weight:600">Entry hash</td><td style="padding:6px 12px;background:#f8fafc;font-family:monospace;font-size:13px">${escapeMarkup(opts.entryHash)}</td></tr>
    <tr><td style="padding:6px 12px;background:#f1f5f9;font-weight:600">Reason</td><td style="padding:6px 12px;background:#f8fafc">${escapeMarkup(opts.errorMessage)}</td></tr>
  </table>
  <p>This usually means your GitHub token has expired or been revoked. Re-connect your account to restore automatic provenance commits:</p>
  <p style="margin:24px 0">
    <a href="${settingsUrl}" style="background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Reconnect GitHub →</a>
  </p>
  <p style="color:#64748b;font-size:13px">Your attestation receipt has still been saved in ForgeProof — only the GitHub commit failed. You can retry from the receipt detail page once your token is refreshed.</p>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:32px 0">
  <p style="color:#94a3b8;font-size:12px">ForgeProof by Flying Cloud Technology</p>
</body>
</html>`;

  await storage.createPendingEmail({
    to: opts.to,
    subject: "ForgeProof: GitHub commit failed — action required",
    bodyText: text,
    bodyHtml: html,
  });

  console.log("[forgeproof] git-commit-failure email queued for", opts.to);
}

const MAX_EMAIL_ATTEMPTS = 5;
// Backoff after 1st, 2nd, 3rd+ failed attempt (minutes)
const RETRY_BACKOFF_MINUTES = [1, 5, 30];

export async function flushEmailQueue(): Promise<void> {
  const due = await storage.getDuePendingEmails();
  if (due.length === 0) return;

  const transport = getTransport();
  if (!transport) {
    console.warn(
      `[forgeproof] SMTP not configured – ${due.length} queued email(s) remain pending`
    );
    return;
  }

  const from = process.env.SMTP_FROM ?? process.env.SMTP_USER;

  for (const email of due) {
    try {
      await transport.sendMail({
        from,
        to: email.to,
        subject: email.subject,
        text: email.bodyText,
        html: email.bodyHtml,
      });
      await storage.updatePendingEmail(email.id, { status: "sent" });
      console.log("[forgeproof] queued email sent to", email.to);
    } catch (err: any) {
      const retryCount = email.retryCount + 1;
      if (retryCount >= MAX_EMAIL_ATTEMPTS) {
        await storage.updatePendingEmail(email.id, { retryCount, status: "failed" });
        console.warn(
          `[forgeproof] email to ${email.to} failed permanently after ${retryCount} attempts:`,
          err?.message ?? err
        );
      } else {
        const backoffMin =
          RETRY_BACKOFF_MINUTES[Math.min(retryCount - 1, RETRY_BACKOFF_MINUTES.length - 1)];
        const nextRetryAt = new Date(Date.now() + backoffMin * 60 * 1000);
        await storage.updatePendingEmail(email.id, { retryCount, nextRetryAt });
        console.warn(
          `[forgeproof] email to ${email.to} failed (attempt ${retryCount}/${MAX_EMAIL_ATTEMPTS}), retrying in ${backoffMin}min:`,
          err?.message ?? err
        );
      }
    }
  }
}
