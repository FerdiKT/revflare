// Long imports run as Workflows: every step is one bounded call into the database object (which does the App Store /
// RevenueCat requests), so each step fits the Free plan and a failure only repeats that step.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { syncNotificationHistory, syncTransactionHistory } from "./apple/ingest";
import { ensureAcquisitionRequests, syncAcquisition } from "./apple/analytics";
import { syncSalesReports } from "./apple/sales";
import { syncProducts } from "./apple/setup";
import { getDb } from "./lib/db";
import { backfillFxRates, recomputeUsd } from "./lib/fx";
import { discoverRevenueCat } from "./lib/revenuecat";
import { runRollups } from "./lib/rollup";
import { errorMessage, now, parseJson } from "./lib/util";

export type JobKind = "apple_backfill" | "revenuecat_discovery" | "sales_reports" | "fx_backfill" | "acquisition";

export interface JobParams {
  appId?: string;
  credentialId?: string;
  days?: number;
  from?: string;
}

const STEP = { retries: { limit: 5, delay: "30 seconds" as const, backoff: "exponential" as const }, timeout: "5 minutes" as const };

export class ImportWorkflow extends WorkflowEntrypoint<Env, { jobId: string }> {
  private async update(jobId: string, patch: { status?: string; progress?: Record<string, unknown>; error?: string | null }) {
    const db = getDb(this.env);
    const t = now();
    await db
      .prepare(
        `UPDATE jobs SET status = COALESCE(?, status), progress = COALESCE(?, progress), error = COALESCE(?, error), updated_at = ?,
         finished_at = CASE WHEN ? IN ('done', 'failed', 'cancelled') THEN ? ELSE finished_at END WHERE id = ?`,
      )
      .bind(patch.status ?? null, patch.progress ? JSON.stringify(patch.progress) : null, patch.error ?? null, t, patch.status ?? "", t, jobId)
      .run();
  }

  async run(event: WorkflowEvent<{ jobId: string }>, step: WorkflowStep) {
    const jobId = event.payload.jobId;
    const job = await step.do("load job", async () => {
      const row = await getDb(this.env).prepare("SELECT id, workspace_id, kind, params FROM jobs WHERE id = ?").bind(jobId).first<{ id: string; workspace_id: string; kind: JobKind; params: string }>();
      if (!row) throw new Error("Job not found");
      return { workspaceId: row.workspace_id, kind: row.kind, params: parseJson<JobParams>(row.params, {}) };
    });
    await step.do("start", () => this.update(jobId, { status: "running" }));
    try {
      if (job.kind === "apple_backfill") await this.appleBackfill(jobId, job.params, step);
      else if (job.kind === "revenuecat_discovery") await this.revenueCat(jobId, job.workspaceId, job.params, step);
      else if (job.kind === "sales_reports") await this.salesReports(jobId, job.workspaceId, job.params, step);
      else if (job.kind === "acquisition") await this.acquisition(jobId, job.workspaceId, step);
      else if (job.kind === "fx_backfill") await step.do("fx", STEP, () => backfillFxRates(this.env, { from: job.params.from ?? "2019-01-01" }));
      await step.do("done", () => this.update(jobId, { status: "done" }));
    } catch (err) {
      await step.do("failed", () => this.update(jobId, { status: "failed", error: errorMessage(err) }));
      throw err;
    }
  }

  private async appleBackfill(jobId: string, params: JobParams, step: WorkflowStep) {
    const appId = params.appId!;
    const progress: Record<string, unknown> = { phase: "notification_history", notifications: 0, transactions: 0, customers: 0 };
    await step.do("products", STEP, async () => {
      const app = await getDb(this.env).prepare("SELECT workspace_id FROM apps WHERE id = ?").bind(appId).first<{ workspace_id: string }>();
      if (app) await syncProducts(this.env, { workspaceId: app.workspace_id, appIds: [appId] });
      return true;
    });
    for (let i = 0; i < 200; i++) {
      const r = await step.do(`history ${i}`, STEP, () => syncNotificationHistory(this.env, { appId, maxRequests: 15, background: true }));
      if (r.budget) {
        // Today's database budget for background work is used up: continue after it resets (00:00 UTC).
        await step.sleep(`history budget ${i}`, "3 hours");
        continue;
      }
      progress.notifications = (progress.notifications as number) + r.processed;
      await step.do(`progress h${i}`, () => this.update(jobId, { progress }));
      if (r.error === "rate_limited") {
        await step.sleep(`history wait ${i}`, "1 minute");
        continue;
      }
      if (r.error) throw new Error(r.error);
      if (r.unavailable) {
        await step.do("progress unavailable", () => this.update(jobId, { progress: { ...progress, phase: "done", unavailable: true } }));
        return;
      }
      if (r.done) break;
    }
    progress.phase = "transaction_history";
    for (let i = 0; i < 500; i++) {
      const r = await step.do(`transactions ${i}`, STEP, () => syncTransactionHistory(this.env, { appId, maxRequests: 25, background: true }));
      if (r.budget) {
        await step.sleep(`transactions budget ${i}`, "3 hours");
        continue;
      }
      progress.transactions = (progress.transactions as number) + r.transactions;
      progress.customers = (progress.customers as number) + r.customers;
      progress.remaining = r.remaining;
      await step.do(`progress t${i}`, () => this.update(jobId, { progress }));
      if (r.error === "rate_limited") {
        await step.sleep(`transactions wait ${i}`, "1 minute");
        continue;
      }
      if (r.error) throw new Error(r.error);
      if (!r.remaining || (!r.requests && !r.customers)) break;
    }
    progress.phase = "metrics";
    await step.do("usd", STEP, () => recomputeUsd(this.env, { appId }));
    await step.do("rollup", STEP, () => runRollups(this.env, { appIds: [appId] }));
    await step.do("progress final", () => this.update(jobId, { progress: { ...progress, phase: "done" } }));
  }

  private async revenueCat(jobId: string, workspaceId: string, params: JobParams, step: WorkflowStep) {
    const progress: Record<string, unknown> = { phase: "discovery", customers: 0, ids: 0 };
    for (let i = 0; i < 1000; i++) {
      const r = await step.do(`discover ${i}`, STEP, () => discoverRevenueCat(this.env, { workspaceId, credentialId: params.credentialId!, maxRequests: 40 }));
      if (r.budget) {
        await step.sleep(`discover budget ${i}`, "3 hours");
        continue;
      }
      Object.assign(progress, { customers: r.customers, ids: r.ids });
      await step.do(`progress d${i}`, () => this.update(jobId, { progress }));
      if (r.rateLimited) {
        await step.sleep(`discover wait ${i}`, "1 minute");
        continue;
      }
      if (r.error) throw new Error(r.error);
      if (r.done) break;
    }
    // Apple fills in the discovered customers.
    const apps = await step.do("apps with pending ids", async () => {
      const { results } = await getDb(this.env).prepare("SELECT DISTINCT app_id FROM pending_history WHERE app_id IN (SELECT id FROM apps WHERE workspace_id = ?)").bind(workspaceId).all<{ app_id: string }>();
      return results.map((r) => r.app_id);
    });
    progress.phase = "transaction_history";
    let n = 0;
    for (const appId of apps) {
      for (let i = 0; i < 1000; i++) {
        const r = await step.do(`transactions ${appId} ${i}`, STEP, () => syncTransactionHistory(this.env, { appId, maxRequests: 25, background: true }));
        if (r.budget) {
          await step.sleep(`budget ${appId} ${i}`, "3 hours");
          continue;
        }
        progress.transactions = ((progress.transactions as number) ?? 0) + r.transactions;
        if (++n % 5 === 0) await step.do(`progress ${appId} ${i}`, () => this.update(jobId, { progress }));
        if (r.error === "rate_limited") {
          await step.sleep(`wait ${appId} ${i}`, "1 minute");
          continue;
        }
        if (r.error) break;
        if (!r.remaining || (!r.requests && !r.customers)) break;
      }
      await step.do(`rollup ${appId}`, STEP, () => runRollups(this.env, { appIds: [appId] }));
    }
    await step.do("progress final", () => this.update(jobId, { progress: { ...progress, phase: "done" } }));
  }

  /** App Analytics: report requests for every app, then every report instance Apple has (oldest first). */
  private async acquisition(jobId: string, workspaceId: string, step: WorkflowStep) {
    const progress: Record<string, unknown> = { phase: "requests", created: 0, existing: 0, failed: 0, instances: 0, rows: 0 };
    for (let i = 0; i < 20; i++) {
      const r = await step.do(`requests ${i}`, STEP, () => ensureAcquisitionRequests(this.env, { workspaceId, limit: 10, retry: i === 0 }));
      if (r.error) throw new Error(r.error);
      progress.created = (progress.created as number) + r.created.length;
      progress.existing = (progress.existing as number) + r.existing.length;
      progress.failed = (progress.failed as number) + r.failed.length;
      if (r.failed.length) progress.lastError = r.failed[r.failed.length - 1].error;
      await step.do(`progress r${i}`, () => this.update(jobId, { progress }));
      if (!r.remaining) break;
    }
    progress.phase = "reports";
    // Every app once (apps checked after the start are done; one with instances left over comes back first).
    const started = await step.do("reports start", async () => Date.now());
    for (let i = 0; i < 300; i++) {
      const r = await step.do(`reports ${i}`, STEP, () => syncAcquisition(this.env, { workspaceId, maxRequests: 40, maxApps: 10, checkedBefore: started }));
      progress.instances = (progress.instances as number) + r.instances;
      progress.rows = (progress.rows as number) + r.rows;
      await step.do(`progress s${i}`, () => this.update(jobId, { progress }));
      if (r.budget) {
        await step.sleep(`reports budget ${i}`, "3 hours");
        continue;
      }
      if (r.rateLimited) {
        await step.sleep(`reports wait ${i}`, "1 minute");
        continue;
      }
      // Every app checked: done (the cron keeps importing new days).
      if (!r.apps) break;
    }
    await step.do("progress final", () => this.update(jobId, { progress: { ...progress, phase: "done" } }));
  }

  private async salesReports(jobId: string, workspaceId: string, params: JobParams, step: WorkflowStep) {
    const progress: Record<string, unknown> = { fetched: 0 };
    for (let i = 0; i < 50; i++) {
      const r = await step.do(`reports ${i}`, STEP, () => syncSalesReports(this.env, { workspaceId, days: params.days ?? 30, maxRequests: 10 }));
      progress.fetched = (progress.fetched as number) + r.fetched.length;
      await step.do(`progress ${i}`, () => this.update(jobId, { progress }));
      if (r.error) throw new Error(r.error);
      if (!r.fetched.length) break;
    }
    await step.do("rollup", STEP, () => runRollups(this.env, { limit: 50 }));
  }
}
