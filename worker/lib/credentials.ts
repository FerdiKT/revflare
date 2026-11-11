import { decryptJson, encryptJson } from "./crypto";
import type { Db } from "./db";
import { newId, now, parseJson } from "./util";

export type CredentialKind = "appstore_iap" | "appstore_connect" | "appstore_reports" | "revenuecat" | "google_play";

export interface Credential {
  id: string;
  workspaceId: string;
  kind: CredentialKind;
  name: string;
  keyId: string | null;
  issuerId: string | null;
  config: Record<string, unknown>;
  /** appstore_*: { privateKey } (PEM); google_play: { privateKey } (the service account's RSA PEM); revenuecat: { apiKey } */
  secret: { privateKey?: string; apiKey?: string };
}

interface Row {
  id: string;
  workspace_id: string;
  kind: CredentialKind;
  name: string;
  key_id: string | null;
  issuer_id: string | null;
  config: string;
  secret: string;
}

async function toCredential(env: Env, db: Db, row: Row): Promise<Credential> {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    name: row.name,
    keyId: row.key_id,
    issuerId: row.issuer_id,
    config: parseJson(row.config, {}),
    secret: await decryptJson(env, db, row.secret),
  };
}

/** The workspace's credential of a kind (the newest; or a specific one by id). */
export async function getCredential(env: Env, db: Db, workspaceId: string, kind: CredentialKind, id?: string | null): Promise<Credential | null> {
  const row = id
    ? await db.prepare("SELECT * FROM credentials WHERE workspace_id = ? AND kind = ? AND id = ?").bind(workspaceId, kind, id).first<Row>()
    : await db.prepare("SELECT * FROM credentials WHERE workspace_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1").bind(workspaceId, kind).first<Row>();
  return row ? toCredential(env, db, row) : null;
}

/**
 * App Store Connect keys for reports (Sales and Trends, App Analytics), in the order to try them: the reports keys
 * (appstore_reports, e.g. one with the Sales role), then the appstore_connect keys, newest first. Same key id only once.
 */
export async function reportCredentials(env: Env, db: Db, workspaceId: string): Promise<Credential[]> {
  const { results } = await db
    .prepare("SELECT * FROM credentials WHERE workspace_id = ? AND kind IN ('appstore_reports', 'appstore_connect') ORDER BY kind = 'appstore_reports' DESC, created_at DESC LIMIT 5")
    .bind(workspaceId)
    .all<Row>();
  const seen = new Set<string>();
  const out: Credential[] = [];
  for (const r of results) {
    if (seen.has(r.key_id ?? r.id)) continue;
    seen.add(r.key_id ?? r.id);
    out.push(await toCredential(env, db, r));
  }
  return out;
}

export async function listCredentials(env: Env, db: Db, workspaceId: string, kind: CredentialKind): Promise<Credential[]> {
  const { results } = await db.prepare("SELECT * FROM credentials WHERE workspace_id = ? AND kind = ? ORDER BY created_at").bind(workspaceId, kind).all<Row>();
  return Promise.all(results.map((r) => toCredential(env, db, r)));
}

export async function saveCredential(
  env: Env,
  db: Db,
  input: { workspaceId: string; kind: CredentialKind; name: string; keyId?: string | null; issuerId?: string | null; config?: Record<string, unknown>; secret: Credential["secret"] },
): Promise<string> {
  const id = newId("cred_");
  const t = now();
  await db
    .prepare("INSERT INTO credentials (id, workspace_id, kind, name, key_id, issuer_id, config, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, input.workspaceId, input.kind, input.name, input.keyId ?? null, input.issuerId ?? null, JSON.stringify(input.config ?? {}), await encryptJson(env, db, input.secret), t, t)
    .run();
  return id;
}

/** Public view (no secret). */
export function credentialView(c: Credential) {
  return { id: c.id, kind: c.kind, name: c.name, keyId: c.keyId, issuerId: c.issuerId, config: c.config };
}
