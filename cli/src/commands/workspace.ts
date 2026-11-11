// Workspace administration: invitations and the instance's database usage (Cloudflare Free plan).

import { str } from "../args.js";
import type { Command } from "../context.js";
import { adminGet } from "./common.js";
import { UsageError, untilUtcMidnight } from "../errors.js";
import { c, eprintln, fmtDate, fmtNum, fmtRelative, println, printJson, table } from "../format.js";
import type { AdminUsage, Invitation, Role } from "../types.js";

const ROLES: Role[] = ["viewer", "admin", "owner"];

export const invite: Command = {
  name: "invite",
  summary: "Create an invitation link to the workspace (valid 7 days).",
  description: "Prints the link to send. With --email only that address can use it. Only owners can invite owners.",
  options: {
    role: { type: "string", arg: "<viewer|admin|owner>", description: "Role of the new member (required)" },
    email: { type: "string", arg: "<email>", description: "Restrict the invitation to this email address" },
  },
  max: 0,
  examples: ["revflare invite --role viewer", "revflare invite --role admin --email ana@example.com"],
  async run(ctx, { values }) {
    const role = str(values.role)?.toLowerCase();
    if (!role) throw new UsageError("Missing --role: viewer, admin or owner");
    if (!ROLES.includes(role as Role)) throw new UsageError(`Invalid --role "${role}": use viewer, admin or owner`);
    const email = str(values.email)?.trim();
    if (email !== undefined && !/^[^\s@]+@[^\s@]+$/.test(email)) throw new UsageError(`Invalid --email "${email}"`);
    const r = await ctx.api.post<{ url: string; expiresAt: number }>("/invitations", { role, ...(email ? { email } : {}) });
    if (ctx.json) return printJson({ role, email: email ?? null, ...r });
    println(r.url);
    eprintln(c.gray(`${role} invitation${email ? ` for ${email}` : ""}, expires ${fmtDate(r.expiresAt)}. Send the link; it works once.`));
  },
};

export const invitations: Command = {
  name: "invitations",
  summary: "Pending invitations to the workspace.",
  max: 0,
  examples: ["revflare invitations", "revflare invitations revoke inv_..."],
  async run(ctx) {
    const r = await ctx.api.get<{ items: Invitation[] }>("/invitations");
    if (ctx.json) return printJson(r);
    if (!r.items.length) return println(c.gray("No pending invitations. Create one: revflare invite --role viewer"));
    const now = ctx.now.getTime();
    println(
      table(
        [{ header: "ID" }, { header: "EMAIL", flex: true }, { header: "ROLE" }, { header: "CREATED BY", flex: true }, { header: "CREATED" }, { header: "EXPIRES" }],
        r.items.map((i) => [i.id, i.email ?? c.gray("anyone with the link"), i.role, i.createdBy ?? "-", fmtDate(i.createdAt), `${fmtDate(i.expiresAt)} ${c.gray(`(${fmtRelative(i.expiresAt, now)})`)}`]),
      ),
    );
  },
};

export const invitationsRevoke: Command = {
  name: "invitations revoke",
  args: "<id...>",
  summary: "Revoke pending invitations (their links stop working).",
  min: 1,
  async run(ctx, { positionals }) {
    for (const id of positionals) await ctx.api.delete(`/invitations/${encodeURIComponent(id)}`);
    if (ctx.json) return printJson({ revoked: positionals });
    println(`${c.green("✓")} Revoked ${positionals.join(", ")}`);
  },
};

export function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let u = 0;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u++;
  }
  return `${u ? v.toFixed(1) : v} ${units[u]}`;
}

const pct = (n: number, of: number) => (of > 0 ? ` (${Math.round((n / of) * 100)}%)` : "");
const used = (n: number, of: number) => {
  const s = `${fmtNum(n)} / ${fmtNum(of)}${pct(n, of)}`;
  return n >= of ? c.red(s) : n >= of * 0.8 ? c.yellow(s) : s;
};

export const usage: Command = {
  name: "usage",
  summary: "Database size and today's Cloudflare Free plan budget (instance admins, revflare login --email).",
  description:
    "On the Workers Free plan the database allows 5M rows read and 100k rows written a day (reset 00:00 UTC); over it\n" +
    "every request fails until the reset. Background work (imports, backfills, history syncs) gets a capped daily share.",
  max: 0,
  async run(ctx) {
    const u = await adminGet<AdminUsage>(ctx, "/admin/usage");
    if (ctx.json) return printJson(u);
    const row = (k: string, v: string) => println(`${c.gray(k.padEnd(22))}${v}`);
    if (u.database) {
      row("Database size", fmtBytes(u.database.size));
      row("Since restart", `${fmtNum(u.database.rowsRead)} rows read, ${fmtNum(u.database.rowsWritten)} written ${c.gray(`(since ${fmtDate(u.database.since)})`)}`);
    } else row("Database", c.gray("D1 (no Durable Object statistics)"));
    println("", c.bold("Background work today"));
    row("Rows read", used(u.background.rowsRead, u.background.readBudget));
    row("Rows written", used(u.background.rowsWritten, u.background.writeBudget));
    println("", c.bold("Free plan limits"));
    row("Rows read per day", fmtNum(u.freePlan.rowsReadPerDay));
    row("Rows written per day", fmtNum(u.freePlan.rowsWrittenPerDay));
    row("Resets", `${u.freePlan.resetsAt} ${c.gray(`(in ${untilUtcMidnight(ctx.now)})`)}`);
  },
};
