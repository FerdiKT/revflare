// Transactional email through Cloudflare Email Sending (the optional `send_email` binding EMAIL, Workers Paid). Used for
// sign-in links, which an instance admin turns on in Admin → Settings; everything else works without it.
import type { Db } from "./db";
import { getSetting } from "./settings";

/** Instance setting ("1" or absent) that turns sign-in links on. */
export const MAGIC_LINK_SETTING = "magic_link_enabled";

/** Tests (TEST_MODE only): a fake EMAIL binding and sender used by the daily digest (cron, inside the database object). */
export const emailTestHooks: { binding: SendEmail | null; from: string | null } = { binding: null, from: null };

/** The EMAIL binding and sender (test hooks first, with TEST_MODE). */
export function emailBinding(env: Env): { binding: SendEmail; from: string } | null {
  if (env.TEST_MODE === "true" && emailTestHooks.binding && emailTestHooks.from) return { binding: emailTestHooks.binding, from: emailTestHooks.from };
  return env.EMAIL && env.EMAIL_FROM?.trim() ? { binding: env.EMAIL, from: env.EMAIL_FROM } : null;
}

/** Email is configured when both the binding and a sender address exist. */
export const emailConfigured = (env: Env) => !!emailBinding(env);

/** Sign-in links are offered when email is configured and an instance admin turned them on. */
export async function magicLinkEnabled(env: Env, db: Db): Promise<boolean> {
  return emailConfigured(env) && (await getSetting(db, MAGIC_LINK_SETTING)) === "1";
}

/** "Name <a@b.c>" or "a@b.c" → the builder's `from`. */
export function sender(from: string): string | { email: string; name: string } {
  const m = from.trim().match(/^(.*?)\s*<([^>]+)>$/);
  return m && m[1] ? { name: m[1].replace(/^"|"$/g, ""), email: m[2].trim() } : (m?.[2] ?? from.trim());
}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export function emailLayout(title: string, body: string, footer: string, width = 440) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:${width}px;background:#fff;border:1px solid #e4e4e7;border-radius:16px;padding:28px">
<tr><td style="font-size:18px;font-weight:600">${title}</td></tr>
${body}
<tr><td style="font-size:12px;color:#71717a">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

/** Subject, plain text and HTML of a sign-in link email. */
export function magicLinkEmail(link: string, host: string, minutes: number) {
  const subject = "Your Revflare sign-in link";
  const text = `Sign in to Revflare (${host}):\n\n${link}\n\nThe link works once and expires in ${minutes} minutes. If you did not ask for it, ignore this email.`;
  const html = emailLayout(
    "Sign in to Revflare",
    `<tr><td style="padding-top:8px;font-size:14px;color:#52525b">Use this button to sign in to ${escapeHtml(host)}.</td></tr>
<tr><td style="padding:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#f95716;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 20px;border-radius:10px">Sign in</a></td></tr>`,
    `The link works once and expires in ${minutes} minutes. If you did not ask for it, ignore this email.<br><br>${escapeHtml(link)}`,
  );
  return { subject, text, html };
}

/** The test email of Admin → Settings. */
export function testEmail(host: string) {
  const subject = "Revflare test email";
  const text = `Email sending works on ${host}. Sign-in links by email can reach this address.`;
  const html = emailLayout("Email sending works", `<tr><td style="padding:8px 0 16px;font-size:14px;color:#52525b">Revflare on ${escapeHtml(host)} can send email to this address.</td></tr>`, "Sent from Admin → Settings.");
  return { subject, text, html };
}

/** Message (and Cloudflare error code) of a failed send, for the admin. */
export function sendError(err: unknown): string {
  const e = err as { message?: string; code?: string } | null;
  const msg = e?.message || String(err);
  return e?.code && !msg.includes(e.code) ? `${msg} (${e.code})` : msg;
}
