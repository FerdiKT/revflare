import type { JobKind, JobParams } from "../workflow";
import type { Db } from "./db";
import { newId, now } from "./util";

/** Creates a job and starts its workflow. A job of the same kind and params already queued or running is reused. */
export async function startJob(env: Env, db: Db, workspaceId: string, kind: JobKind, params: JobParams, userId: string | null): Promise<{ id: string; reused: boolean }> {
  const p = JSON.stringify(params);
  const running = await db
    .prepare("SELECT id FROM jobs WHERE workspace_id = ? AND kind = ? AND params = ? AND status IN ('queued', 'running') AND updated_at > ?")
    .bind(workspaceId, kind, p, now() - 30 * 60_000)
    .first<{ id: string }>();
  if (running) return { id: running.id, reused: true };
  const id = newId("job_");
  const t = now();
  await db
    .prepare("INSERT INTO jobs (id, workspace_id, kind, status, params, created_by, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)")
    .bind(id, workspaceId, kind, p, userId, t, t)
    .run();
  await env.IMPORT_WORKFLOW.create({ id, params: { jobId: id } });
  return { id, reused: false };
}
