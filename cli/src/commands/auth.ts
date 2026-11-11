import { Api } from "../api.js";
import { str } from "../args.js";
import { DEFAULT_PROFILE, configPath, normalizeUrl, profileName, readConfig, writeConfig } from "../config.js";
import type { Command } from "../context.js";
import { CliError, QuotaError, UsageError } from "../errors.js";
import { c, println, printJson } from "../format.js";
import { prompt as ttyPrompt, readStdin } from "../io.js";
import type { Me } from "../types.js";
import { VERSION } from "../version.js";

export const login: Command = {
  name: "login",
  summary: "Save the URL and workspace API key (rf_...) of a Revflare instance.",
  description:
    "The key is checked against the server (GET /me), then saved to ~/.config/revflare/config.json (mode 0600) under a\n" +
    "profile (default: \"default\"), which becomes the current one. Without --key the key is asked for without echo (TTY),\n" +
    "or read from stdin when piped. Env vars REVFLARE_URL / REVFLARE_API_KEY override the saved values.",
  options: {
    url: { type: "string", arg: "<url>", description: "Your Revflare URL, e.g. https://revflare.example.com" },
    key: { type: "string", arg: "<rf_...>", description: "Workspace API key (prefer the prompt or stdin: flags end up in shell history)" },
    email: {
      type: "string",
      arg: "<email>",
      description: "Sign in as a user with email + password instead (saves a device token, rfd_...): needed for `revflare admin` (instance admins)",
    },
  },
  max: 0,
  examples: [
    "revflare login --url https://revflare.example.com",
    "echo \"$REVFLARE_KEY\" | revflare login --url https://revflare.example.com",
    "revflare login --profile work --url https://rf.work.example --key rf_...",
    "revflare login --profile admin --url https://revflare.example.com --email you@example.com",
  ],
  async run(ctx, { values }) {
    const cfg = readConfig(configPath(ctx.env));
    const name = str(values.profile) || ctx.env.REVFLARE_PROFILE || (Object.keys(cfg.profiles).length ? cfg.current : undefined) || DEFAULT_PROFILE;
    const existing = cfg.profiles[name];
    const ask = ctx.deps.prompt ?? ttyPrompt;
    const tty = !!process.stdin.isTTY && !ctx.deps.readStdin;
    let url = str(values.url) ?? existing?.url;
    if (!url) {
      if (!tty) throw new UsageError("Missing --url", "login");
      url = await ask("Revflare URL: ");
    }
    url = normalizeUrl(url);
    let key = str(values.key);
    const email = str(values.email)?.trim();
    if (email !== undefined) {
      if (key) throw new UsageError("Use either --key or --email", "login");
      if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new UsageError(`Invalid --email "${email}"`, "login");
      const password = tty ? await ask("Password (input hidden): ", { secret: true }) : ((await (ctx.deps.readStdin ?? readStdin)(false)) ?? "").replace(/\r?\n$/, "");
      if (!password) throw new UsageError("Missing password: run in a terminal to be prompted, or pipe it on stdin", "login");
      try {
        const r = await new Api(url, "", ctx.deps.fetch, () => ctx.now).post<{ token: string }>("/auth/device", { email, password, deviceName: "revflare CLI" });
        key = r.token;
      } catch (err) {
        if (err instanceof QuotaError) throw err;
        throw new CliError(`Login failed: ${(err as Error).message.replace(/ \(check your API key: revflare login\)$/, "")}`);
      }
    }
    if (!key) {
      if (tty) key = await ask("API key (rf_..., input hidden): ", { secret: true });
      else key = ((await (ctx.deps.readStdin ?? readStdin)(false)) ?? "").trim();
    }
    if (!key) throw new UsageError("Missing API key: pass --key, pipe it on stdin, or run in a terminal to be prompted", "login");
    let me: Me;
    try {
      me = await new Api(url, key, ctx.deps.fetch, () => ctx.now).get<Me>("/me");
    } catch (err) {
      if (err instanceof QuotaError) throw err;
      throw new CliError(`Login failed: ${(err as Error).message}`);
    }
    cfg.profiles[name] = { url, key };
    cfg.current = name;
    writeConfig(cfg, configPath(ctx.env));
    if (ctx.json) return printJson({ profile: name, url, user: me.user, workspace: me.workspace, config: configPath(ctx.env) });
    println(`${c.green("✓")} Logged in to ${c.bold(url)} as ${c.bold(me.user.name)} <${me.user.email}>`);
    if (me.workspace) println(`  Workspace: ${c.bold(me.workspace.name)} (${me.workspace.role}, ${me.workspace.currency})`);
    println(c.gray(`  Profile "${name}" saved to ${configPath(ctx.env)}`));
    if (key.startsWith("rfd_")) println(c.gray("  Signed in as a user (device token): revflare logout ends this sign-in."));
    else if (!key.startsWith("rf_")) println(c.yellow("  Note: Revflare workspace API keys start with rf_"));
  },
};

export const logout: Command = {
  name: "logout",
  summary: "Remove the saved credentials of a profile (the current one by default).",
  options: { all: { type: "boolean", description: "Remove every profile" } },
  max: 0,
  examples: ["revflare logout", "revflare logout --profile work"],
  async run(ctx, { values }) {
    const path = configPath(ctx.env);
    const cfg = readConfig(path);
    const removed: string[] = [];
    const before = { ...cfg.profiles };
    if (values.all) {
      removed.push(...Object.keys(cfg.profiles));
      cfg.profiles = {};
      delete cfg.current;
    } else {
      const name = profileName(str(values.profile), cfg, ctx.env);
      if (cfg.profiles[name]) {
        delete cfg.profiles[name];
        removed.push(name);
      }
      if (cfg.current === name) {
        const next = Object.keys(cfg.profiles)[0];
        if (next) cfg.current = next;
        else delete cfg.current;
      }
    }
    writeConfig(cfg, path);
    // User sign-ins (device tokens) are ended on the server too; API keys stay valid (revoke them in the web app).
    for (const name of removed) {
      const p = before[name];
      if (p?.key.startsWith("rfd_")) await new Api(p.url, p.key, ctx.deps.fetch, () => ctx.now).post("/auth/logout").catch(() => {});
    }
    if (ctx.json) return printJson({ removed, current: cfg.current ?? null });
    println(removed.length ? `Removed profile${removed.length > 1 ? "s" : ""} ${removed.join(", ")}.` : "Nothing to remove.");
    if (ctx.env.REVFLARE_API_KEY) println(c.yellow("REVFLARE_API_KEY is still set in your environment."));
  },
};

export const whoami: Command = {
  name: "whoami",
  summary: "Show the user and workspace of the API key, its permissions, and where the credentials come from.",
  max: 0,
  examples: ["revflare whoami", "revflare whoami --json"],
  async run(ctx) {
    const me = await ctx.api.get<Me>("/me");
    const { url, profile, source, key } = ctx.auth;
    const keyHint = `${key.slice(0, 7)}…`;
    if (ctx.json) return printJson({ url, profile, source, key: keyHint, user: me.user, workspace: me.workspace, auth: me.auth, server: { version: me.version, apiVersion: me.apiVersion } });
    println(`${c.bold(me.user.name)} <${me.user.email}>${me.user.isAdmin ? c.gray("  (instance admin)") : ""}`);
    if (me.workspace) {
      println(`Workspace:   ${c.bold(me.workspace.name)} ${c.gray(me.workspace.id)}`);
      println(`Role:        ${me.workspace.role}`);
      println(`Currency:    ${me.workspace.currency}`);
      println(`Permissions: ${me.workspace.permissions.join(", ")}`);
    } else println(c.yellow("The key has no workspace."));
    println(`Server:      ${url} ${c.gray(`(v${me.version}, API ${me.apiVersion})`)}`);
    println(c.gray(`Profile:     ${source === "env" ? "(environment variables)" : profile}${source === "mixed" ? " + environment" : ""}  key ${keyHint}`));
  },
};

export const version: Command = {
  name: "version",
  summary: "Show the CLI version and the version of the Revflare server it talks to.",
  max: 0,
  async run(ctx) {
    let server: { url: string; version: string; apiVersion: number } | null = null;
    let url: string | null = null;
    try {
      url = ctx.auth.url;
    } catch {
      /* not logged in */
    }
    if (url) {
      try {
        const me = await ctx.api.get<Me>("/me");
        server = { url, version: me.version, apiVersion: me.apiVersion };
      } catch {
        /* unreachable */
      }
    }
    if (ctx.json) return printJson({ cli: VERSION, server });
    println(`revflare CLI  ${c.bold(VERSION)}`);
    if (!url) println(c.gray("Server        not logged in (revflare login)"));
    else if (!server) println(`Server        ${url} ${c.gray("(unreachable)")}`);
    else println(`Server        ${url}  ${c.bold(`v${server.version}`)} ${c.gray(`(API ${server.apiVersion})`)}`);
  },
};

export const mcp: Command = {
  name: "mcp",
  summary: "Print the MCP server config (Streamable HTTP at <url>/mcp with the API key) for Claude and other agents.",
  description:
    "The JSON goes into an MCP client's config (Claude Desktop's claude_desktop_config.json \"mcpServers\", a project's\n" +
    ".mcp.json...). It contains the API key: do not commit it. Claude Code: --claude-code prints the `claude mcp add` command.",
  options: {
    name: { type: "string", arg: "<name>", description: "Server name in the config (default: revflare)" },
    "claude-code": { type: "boolean", description: "Print a `claude mcp add` command instead of JSON" },
  },
  max: 0,
  examples: ["revflare mcp", "revflare mcp --claude-code"],
  async run(ctx, { values }) {
    const { url, key } = ctx.auth;
    const name = str(values.name) || "revflare";
    const endpoint = `${url}/mcp`;
    if (values["claude-code"]) {
      println(`claude mcp add --transport http ${name} ${endpoint} --header "Authorization: Bearer ${key}"`);
      return;
    }
    printJson({ mcpServers: { [name]: { type: "http", url: endpoint, headers: { Authorization: `Bearer ${key}` } } } });
  },
};
