// Database access. Revflare keeps all its data in SQLite inside one Durable Object (`RevflareDatabase`), behind a
// small D1-compatible interface (`prepare().bind().first/all/run`, `batch`). Binding a D1 database as `D1` switches
// to D1 without code changes. Heavy work (metrics, JWS verification, App Store syncs) runs *inside* the Durable Object
// through `dbCall()`: it has a 30 s CPU budget per call instead of the Worker's ~10 ms on the Free plan, and pays no
// RPC per query.

import { DurableObject } from "cloudflare:workers";
import { migrate } from "./migrate";

export type SqlValue = string | number | null | ArrayBuffer;

export interface RunMeta {
  changes: number;
  last_row_id: number;
}

export interface Result<T> {
  results: T[];
  meta: RunMeta;
}

export interface Stmt {
  bind(...values: unknown[]): Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<Result<T>>;
  run(): Promise<Result<unknown>>;
}

export interface Db {
  prepare(sql: string): Stmt;
  batch<T = unknown>(statements: Stmt[]): Promise<Result<T>[]>;
}

type Mode = "all" | "first" | "run";

export interface Query {
  sql: string;
  params: SqlValue[];
  mode: Mode;
}

interface Executor {
  exec(queries: Query[], transaction: boolean): Promise<Result<unknown>[]>;
}

function toSqlValue(v: unknown): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number" || typeof v === "string") return v;
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer;
  return JSON.stringify(v);
}

class SqlStmt implements Stmt {
  constructor(
    private readonly executor: Executor,
    readonly sql: string,
    readonly params: SqlValue[] = [],
  ) {}

  bind(...values: unknown[]): Stmt {
    return new SqlStmt(this.executor, this.sql, values.map(toSqlValue));
  }

  query(mode: Mode): Query {
    return { sql: this.sql, params: this.params, mode };
  }

  async first<T>(): Promise<T | null> {
    const [r] = await this.executor.exec([this.query("first")], false);
    return (r.results[0] as T | undefined) ?? null;
  }

  async all<T>(): Promise<Result<T>> {
    const [r] = await this.executor.exec([this.query("all")], false);
    return r as Result<T>;
  }

  async run(): Promise<Result<unknown>> {
    const [r] = await this.executor.exec([this.query("run")], false);
    return r;
  }
}

class SqlDb implements Db {
  constructor(private readonly executor: Executor) {}

  prepare(sql: string): Stmt {
    return new SqlStmt(this.executor, sql);
  }

  async batch<T>(statements: Stmt[]): Promise<Result<T>[]> {
    if (!statements.length) return [];
    const queries = statements.map((s) => {
      if (!(s instanceof SqlStmt)) throw new Error("Foreign statement in batch");
      return s.query("all");
    });
    return (await this.executor.exec(queries, true)) as Result<T>[];
  }
}

/** Rows read / written by this object since it started (Free plan budget: 5M read, 100k written a day). */
export const usage = { since: Date.now(), rowsRead: 0, rowsWritten: 0 };

/** Runs queries on the Durable Object's SQLite (synchronously, inside the object). */
function execLocal(sql: SqlStorage, q: Query): Result<unknown> {
  const cursor = sql.exec(q.sql, ...q.params);
  const rows = cursor.toArray();
  usage.rowsRead += cursor.rowsRead;
  usage.rowsWritten += cursor.rowsWritten;
  if (/^\s*(select|with)\b/i.test(q.sql) && q.mode !== "run") return { results: rows, meta: { changes: 0, last_row_id: 0 } };
  const m = sql.exec("SELECT changes() AS c, last_insert_rowid() AS r").one() as { c: number; r: number };
  return { results: rows, meta: { changes: m.c, last_row_id: m.r } };
}

function localExecutor(storage: DurableObjectStorage): Executor {
  return {
    async exec(queries, transaction) {
      if (!transaction || queries.length === 1) return queries.map((q) => execLocal(storage.sql, q));
      return storage.transactionSync(() => queries.map((q) => execLocal(storage.sql, q)));
    },
  };
}

// Heavy computations that run inside the database object (see dbCall). Registered by the modules that define them.
type DbFunction = (db: Db, args: any, env: Env) => Promise<unknown>;
const functions = new Map<string, DbFunction>();

export function defineDbFunction<A, R>(name: string, fn: (db: Db, args: A, env: Env) => Promise<R>): (env: Env, args: A) => Promise<R> {
  functions.set(name, fn as DbFunction);
  return (env, args) => dbCall<R>(env, name, args);
}

export class RevflareDatabase extends DurableObject<Env> {
  private readonly db: Db;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new SqlDb(localExecutor(ctx.storage));
    ctx.blockConcurrencyWhile(() => migrate(this.db));
  }

  async exec(queries: Query[], transaction: boolean): Promise<Result<unknown>[]> {
    return localExecutor(this.ctx.storage).exec(queries, transaction);
  }

  async call(name: string, args: unknown): Promise<unknown> {
    const fn = functions.get(name);
    if (!fn) throw new Error(`Unknown database function ${name}`);
    // Functions that call other database functions get them in-process (see dbCall), not as RPCs to ourselves.
    return fn(this.db, args, { ...this.env, [LOCAL_DB]: this.db } as Env);
  }

  /** Size of the database in bytes and rows read / written since the object started. */
  async stats(): Promise<{ size: number; since: number; rowsRead: number; rowsWritten: number }> {
    return { size: this.ctx.storage.sql.databaseSize, ...usage };
  }
}

/** Set on the env handed to functions running inside the database object. */
const LOCAL_DB = "__revflareLocalDb";
const localDb = (env: Env): Db | undefined => (env as unknown as Record<string, Db | undefined>)[LOCAL_DB];

function stub(env: Env) {
  return env.DATABASE.get(env.DATABASE.idFromName("main"));
}

/** The database for this request. */
export function getDb(env: Env): Db {
  const local = localDb(env);
  if (local) return local;
  if (env.D1) return env.D1 as unknown as Db;
  const s = stub(env);
  return new SqlDb({
    exec: (queries, transaction) => s.exec(queries, transaction) as Promise<Result<unknown>[]>,
  });
}

/** Runs a function registered with defineDbFunction next to the data (inside the Durable Object). */
export async function dbCall<R>(env: Env, name: string, args: unknown): Promise<R> {
  if (env.D1 || localDb(env)) {
    const fn = functions.get(name);
    if (!fn) throw new Error(`Unknown database function ${name}`);
    return (await fn(getDb(env), args, env)) as R;
  }
  return (await stub(env).call(name, args)) as R;
}

/** Database size and row counters (Durable Object database only). */
export async function dbStats(env: Env): Promise<{ size: number; since: number; rowsRead: number; rowsWritten: number } | null> {
  if (env.D1) return null;
  return stub(env).stats();
}
