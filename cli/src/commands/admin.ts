// Instance administration (GET /admin/*): overview, users, workspaces. The server refuses workspace API keys here, so
// these commands need a user sign-in: `revflare login --email` (an instance admin's device token, rfd_...).

import type { Command } from "../context.js";
import { adminGet } from "./common.js";
import { c, fmtDate, fmtMoney, fmtNum, fmtRelative, println, printJson, table } from "../format.js";
import type { AdminOverview, AdminUser, AdminWorkspace } from "../types.js";
import { fmtBytes } from "./workspace.js";

const DESCRIPTION = "Instance admins only, signed in with `revflare login --email` (workspace API keys cannot use admin routes).";

export const adminOverview: Command = {
  name: "admin overview",
  summary: "Instance overview: users, workspaces, apps, sales, jobs, cron, database usage, version (instance admins).",
  description: DESCRIPTION,
  max: 0,
  examples: ["revflare admin overview", "revflare admin overview --json"],
  async run(ctx) {
    const o = await adminGet<AdminOverview>(ctx, "/admin/overview");
    if (ctx.json) return printJson(o);
    const now = ctx.now.getTime();
    const row = (k: string, v: string) => println(`${c.gray(k.padEnd(18))}${v}`);
    const k = o.counts;
    row("Users", `${fmtNum(k.users)} ${c.gray(`(${k.activeLast30d} active in 30 days, ${k.admins} admin${k.admins === 1 ? "" : "s"}${k.disabledUsers ? `, ${k.disabledUsers} disabled` : ""})`)}`);
    row("Workspaces", fmtNum(k.workspaces));
    row("Apps", `${fmtNum(k.apps)}${k.archivedApps ? c.gray(` (+${k.archivedApps} archived)`) : ""}`);
    row("API keys / devices", `${fmtNum(k.apiKeys)} / ${fmtNum(k.devices)}`);
    row("Purchases", `${fmtNum(o.sales.purchases30d)} in 30 days ${c.gray(`(${fmtNum(o.sales.purchases)} all time)`)}`);
    row("Revenue (30 days)", fmtMoney(o.sales.revenue30dUsd, "USD"));
    println("", c.bold("Background work"));
    row("Cron", o.cron.lastRunAt ? `${fmtRelative(o.cron.lastRunAt, now)}${o.cron.stale ? c.yellow("  stale") : ""}` : c.yellow("not run yet"));
    row("Jobs", `${o.jobs.running} running, ${o.jobs.queued} queued, ${o.jobs.failed7d ? c.red(`${o.jobs.failed7d} failed`) : "0 failed"} (7 days)`);
    for (const j of o.jobs.recentFailed) println(c.gray(`  ${fmtDate(j.at)} ${j.kind} in ${j.workspaceName ?? j.workspaceId}: ${j.error ?? "failed"}`));
    row("Open alerts", fmtNum(o.alerts.open));
    println("", c.bold("Database"));
    if (o.usage.database) row("Size", fmtBytes(o.usage.database.size));
    row("Background today", `${fmtNum(o.usage.background.rowsRead)} / ${fmtNum(o.usage.background.readBudget)} rows read, ${fmtNum(o.usage.background.rowsWritten)} / ${fmtNum(o.usage.background.writeBudget)} written`);
    println("", c.bold("Version"));
    const u = o.update;
    row("Running", `v${o.version.version} ${c.gray(`(${o.version.commit})`)}`);
    const status = u.updateAvailable
      ? c.yellow(`v${u.latest} available${u.url ? `: ${u.url}` : ""}`)
      : u.status === "ok"
        ? c.green(u.latest ? `up to date (latest v${u.latest})` : "up to date")
        : u.status === "never"
          ? c.gray("not checked yet")
          : u.status === "disabled"
            ? c.gray("update check off")
            : c.yellow(u.message ?? u.status);
    row("Updates", `${status}${u.checkedAt ? c.gray(`  checked ${fmtRelative(u.checkedAt, now)}`) : ""}`);
  },
};

export const adminUsers: Command = {
  name: "admin users",
  summary: "Every user of the instance: admin, status, last sign-in, workspaces (instance admins).",
  description: DESCRIPTION,
  max: 0,
  examples: ["revflare admin users", "revflare admin users --json"],
  async run(ctx) {
    const r = await adminGet<{ items: AdminUser[] }>(ctx, "/admin/users");
    if (ctx.json) return printJson(r);
    const now = ctx.now.getTime();
    println(
      table(
        [{ header: "ID" }, { header: "NAME", flex: true }, { header: "EMAIL", flex: true }, { header: "ADMIN" }, { header: "STATUS" }, { header: "LAST SIGN-IN" }, { header: "WORKSPACES", flex: true }],
        r.items.map((u) => [
          u.id,
          u.name,
          u.email,
          u.isAdmin ? "yes" : "",
          u.status === "active" ? c.green("active") : c.red("disabled"),
          u.lastLoginAt ? fmtRelative(u.lastLoginAt, now) : c.gray("never"),
          u.workspaces.map((w) => `${w.name} (${w.role})`).join(", ") || c.gray("-"),
        ]),
      ),
    );
  },
};

export const adminWorkspaces: Command = {
  name: "admin workspaces",
  summary: "Every workspace of the instance: owners, members, apps (instance admins).",
  description: DESCRIPTION,
  max: 0,
  examples: ["revflare admin workspaces", "revflare admin workspaces --json"],
  async run(ctx) {
    const r = await adminGet<{ items: AdminWorkspace[] }>(ctx, "/admin/workspaces");
    if (ctx.json) return printJson(r);
    println(
      table(
        [{ header: "ID" }, { header: "NAME", flex: true }, { header: "CURRENCY" }, { header: "OWNERS", flex: true }, { header: "MEMBERS", align: "right" }, { header: "APPS", align: "right" }, { header: "CREATED" }],
        r.items.map((w) => [w.id, w.name, w.currency, w.owners.map((o) => o.email).join(", ") || c.gray("-"), w.members, w.apps, fmtDate(w.createdAt)]),
      ),
    );
  },
};
