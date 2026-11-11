import { Api, type FetchLike } from "./api.js";
import type { CommandDef, Parsed } from "./args.js";
import { resolveAuth, type ResolvedAuth } from "./config.js";
import type { AppsResponse, Me } from "./types.js";

/** Runs a local command (the `revenuecat` CLI): returns stdout, throws with stderr on a non-zero exit. */
export type Exec = (cmd: string, args: string[]) => Promise<string>;

export interface Deps {
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
  /** Reads piped stdin (null when there is none). Injected in tests. */
  readStdin?: (implicit: boolean) => Promise<string | null>;
  /** Interactive prompt (login). */
  prompt?: (question: string, opts?: { secret?: boolean }) => Promise<string>;
  now?: () => Date;
  exec?: Exec;
  sleep?: (ms: number) => Promise<void>;
}

export class Ctx {
  readonly json: boolean;
  private _api?: Api;
  private _auth?: ResolvedAuth;
  private _apps?: Promise<AppsResponse>;
  private _me?: Promise<Me>;

  constructor(
    readonly parsed: Parsed,
    readonly deps: Deps,
  ) {
    this.json = !!parsed.values.json;
  }

  get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env;
  }

  get now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  get profileFlag(): string | undefined {
    return typeof this.parsed.values.profile === "string" ? this.parsed.values.profile : undefined;
  }

  get auth(): ResolvedAuth {
    return (this._auth ??= resolveAuth(this.profileFlag, this.env));
  }

  get api(): Api {
    return (this._api ??= new Api(this.auth.url, this.auth.key, this.deps.fetch, () => this.now));
  }

  /** GET /me, once per command. */
  me(): Promise<Me> {
    return (this._me ??= this.api.get<Me>("/me"));
  }

  /** The currency amounts come back in: --currency, else the workspace's. */
  async currency(flag?: string): Promise<string> {
    return flag?.toUpperCase() || (await this.me()).workspace?.currency || "USD";
  }

  /** GET /apps (archived included), once per command. */
  apps(): Promise<AppsResponse> {
    return (this._apps ??= this.api.get<AppsResponse>("/apps"));
  }
}

export interface Command extends CommandDef {
  run(ctx: Ctx, args: Parsed): Promise<void>;
}
