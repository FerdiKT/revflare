import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowDown, ArrowLeft, ArrowUp, Download, Eye, Filter, Pencil, Plus, SlidersHorizontal, Trash2, TriangleAlert, Upload, X } from "lucide-react";
import { COUNTRY_NAMES, flag } from "@shared/countries";
import {
  RC_CONDITION_COLORS,
  RC_CONDITION_NAME_RE,
  RC_LIMITS,
  RC_PARAMETER_KEY_RE,
  RC_VALUE_TYPES,
  RC_VERSION_OPS,
  type RemoteConfig,
  type RemoteConfigCondition,
  type RemoteConfigConditionColor,
  type RemoteConfigEvaluation,
  type RemoteConfigImport,
  type RemoteConfigParameter,
  type RemoteConfigRule,
  type RemoteConfigRuleType,
  type RemoteConfigValueType,
  type RemoteConfigVersionOp,
  INSTALL_SOURCES,
  SDK_ENVIRONMENTS,
  type InstallSource,
  type SdkEnvironment,
} from "@shared/types";
import { AppIcon } from "../components/Logo";
import { Button, IconButton } from "../components/ui/Button";
import { useConfirm } from "../components/ui/Confirm";
import { Dialog } from "../components/ui/Dialog";
import { Checkbox, Field, Input, Select, Textarea } from "../components/ui/Form";
import { Badge, Card, CardHeader, EmptyState, ErrorState, Skeleton, Table, td, th } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { cn } from "../lib/format";
import { useSession } from "../lib/session";
import { useFetch } from "../lib/useFetch";

type Config = { conditions: RemoteConfigCondition[]; parameters: RemoteConfigParameter[] };

const COLOR_DOT: Record<RemoteConfigConditionColor, string> = {
  blue: "bg-blue-500",
  brown: "bg-amber-800",
  cyan: "bg-cyan-500",
  deep_orange: "bg-orange-600",
  green: "bg-emerald-500",
  indigo: "bg-indigo-500",
  lime: "bg-lime-500",
  orange: "bg-amber-500",
  pink: "bg-pink-500",
  purple: "bg-purple-500",
  teal: "bg-teal-500",
};
const dot = (c?: RemoteConfigConditionColor | null) => cn("inline-block size-2 shrink-0 rounded-full", c ? COLOR_DOT[c] : "bg-zinc-400");

const RULE_LABELS: Record<RemoteConfigRuleType, string> = {
  country: "Country (storefront)",
  ip_country: "Country (IP)",
  storefront: "App Store storefront",
  language: "Language",
  locale: "Locale",
  app_version: "App version",
  app_build: "App build",
  os_version: "iOS version",
  sdk_version: "RevflareKit version",
  percent: "Percent of installs",
  install_id: "Install ids (testers)",
  source: "Acquisition source",
  apple_ads_campaign: "Apple Ads campaign",
  apple_ads_ad_group: "Apple Ads ad group",
  apple_ads_keyword: "Apple Ads keyword",
  environment: "Build (environment)",
};
/** Rules whose values are free strings (not source / environment). */
type StringListRule = Exclude<Extract<RemoteConfigRule, { values: unknown }>, { type: "source" | "environment" }>;
const ADS_ID_RULES: RemoteConfigRuleType[] = ["apple_ads_campaign", "apple_ads_ad_group", "apple_ads_keyword"];
const SOURCE_LABELS: Record<InstallSource, string> = {
  apple_ads: "Apple Ads",
  google_ads: "Google Ads (gclid)",
  referral: "Referral (utm_source)",
  organic: "Organic",
  unknown: "Unknown (not answered yet, e.g. first launch)",
};
const ENV_LABELS: Record<SdkEnvironment, string> = {
  production: "Production (App Store / Google Play)",
  sandbox: "Sandbox (TestFlight / development / Play test track)",
  xcode: "Xcode (StoreKit configuration)",
  debug: "Debug build (Android)",
};
const COUNTRY_RULES: RemoteConfigRuleType[] = ["country", "ip_country", "storefront"];
const VERSION_RULES: RemoteConfigRuleType[] = ["app_version", "app_build", "os_version", "sdk_version"];
const ALL_COUNTRIES = Object.keys(COUNTRY_NAMES).sort((a, b) => COUNTRY_NAMES[a].localeCompare(COUNTRY_NAMES[b]));

const isInApp = (v: unknown) => !!v && typeof v === "object" && (v as { useInAppDefault?: unknown }).useInAppDefault === true;
const plain = (r: RemoteConfig | Config): Config => ({ conditions: r.conditions, parameters: r.parameters });

function describeRule(r: RemoteConfigRule): string {
  if (r.type === "percent") return `${r.to - r.from}% of installs (${r.from}–${r.to}${r.seed ? `, seed ${r.seed}` : ""})`;
  if ("values" in r) {
    const vals = COUNTRY_RULES.includes(r.type) ? r.values.map((c) => `${flag(c)} ${c}`) : r.values;
    return `${RULE_LABELS[r.type]}: ${vals.length > 5 ? `${vals.slice(0, 5).join(", ")} +${vals.length - 5}` : vals.join(", ")}`;
  }
  return `${RULE_LABELS[r.type]} ${r.op} ${r.value}`;
}

export function showValue(v: unknown, max = 60): string {
  if (isInApp(v)) return "in-app default";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// --- Typed value drafts -------------------------------------------------------------------------------------------

export const toDraft = (type: RemoteConfigValueType, v: unknown): string =>
  v === undefined ? (type === "boolean" ? "false" : "") : type === "string" ? String(v) : type === "json" ? JSON.stringify(v, null, 2) : String(v);

export function fromDraft(type: RemoteConfigValueType, text: string): { value: unknown } | { error: string } {
  if (type === "string") return new TextEncoder().encode(text).length > RC_LIMITS.valueBytes ? { error: "Larger than 32 KB" } : { value: text };
  if (type === "number") {
    const n = Number(text);
    return text.trim() === "" || !Number.isFinite(n) ? { error: "Not a number" } : { value: n };
  }
  if (type === "boolean") return { value: text === "true" };
  try {
    const v = JSON.parse(text) as unknown;
    if (new TextEncoder().encode(JSON.stringify(v)).length > RC_LIMITS.valueBytes) return { error: "Larger than 32 KB" };
    return { value: v };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function ValueInput({ type, value, onChange, label, invalid }: { type: RemoteConfigValueType; value: string; onChange: (v: string) => void; label: string; invalid?: boolean }) {
  if (type === "boolean")
    return (
      <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="true">true</option>
        <option value="false">false</option>
      </Select>
    );
  if (type === "json") return <Textarea aria-label={label} rows={4} spellCheck={false} className="font-mono text-xs" placeholder={'{ "title": "Go Pro" }'} value={value} invalid={invalid} onChange={(e) => onChange(e.target.value)} />;
  return <Input aria-label={label} className={type === "number" ? "font-mono text-xs" : undefined} inputMode={type === "number" ? "decimal" : undefined} value={value} invalid={invalid} onChange={(e) => onChange(e.target.value)} />;
}

// --- Page ---------------------------------------------------------------------------------------------------------

/** Apps → app → Remote config: parameters, conditions (ordered), preview as a device, Firebase import, JSON export. */
export function RemoteConfigPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const manage = can("manage");
  const app = useFetch(`app:${id}`, () => api.apps.get(id), { tags: ["apps"] });
  const r = useFetch(`remote-config:${id}`, () => api.apps.remoteConfig.get(id), { tags: ["apps"] });
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [editParam, setEditParam] = useState<{ original: string | null; p: RemoteConfigParameter } | null>(null);
  const [editCond, setEditCond] = useState<{ original: string | null; c: RemoteConfigCondition } | null>(null);
  const [importing, setImporting] = useState(false);
  const cfg = r.data;

  /** Saves the whole config (PUT); the response is the new config. */
  const save = async (name: string, next: Config, ok: string) => {
    setBusy(name);
    try {
      const res = await api.apps.remoteConfig.replace(id, next);
      r.setData(() => res);
      toast.success(ok);
      return res;
    } catch (err) {
      toast.error(err);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const back = (
    <Link to={`/apps/${id}`} className="mb-4 inline-flex items-center gap-1.5 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
      <ArrowLeft className="size-4" /> {app.data?.name ?? "App"}
    </Link>
  );
  if (r.error)
    return (
      <>
        {back}
        <ErrorState error={r.error} onRetry={r.refetch} />
      </>
    );
  if (!cfg)
    return (
      <>
        {back}
        <div className="space-y-5">
          <Skeleton className="h-16" />
          <Skeleton className="h-72" />
          <Skeleton className="h-48" />
        </div>
      </>
    );

  const base = plain(cfg);
  const condByName = new Map(cfg.conditions.map((c) => [c.name, c]));

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(base, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `remote-config-${(app.data?.bundleId ?? id).replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const removeParam = async (p: RemoteConfigParameter) => {
    if (!(await confirm({ title: `Delete ${p.key}?`, message: "Apps fall back to their in-app default within a minute (plus their fetch interval).", confirmLabel: "Delete", danger: true }))) return;
    await save(`param:${p.key}`, { ...base, parameters: base.parameters.filter((x) => x.key !== p.key) }, `${p.key} deleted`);
  };

  const removeCond = async (c: RemoteConfigCondition) => {
    const users = base.parameters.filter((p) => c.name in p.conditionalValues).map((p) => p.key);
    if (!(await confirm({ title: `Delete condition ${c.name}?`, message: users.length ? `Its values on ${users.join(", ")} are removed too.` : "No parameter uses it.", confirmLabel: "Delete", danger: true }))) return;
    await save(
      `cond:${c.name}`,
      {
        conditions: base.conditions.filter((x) => x.name !== c.name),
        parameters: base.parameters.map((p) => {
          const { [c.name]: _, ...rest } = p.conditionalValues;
          return { ...p, conditionalValues: rest };
        }),
      },
      `Condition ${c.name} deleted`,
    );
  };

  const moveCond = (i: number, d: -1 | 1) => {
    const next = [...base.conditions];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    return save(`move:${i}`, { ...base, conditions: next }, "Priority changed");
  };

  return (
    <>
      {back}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        {app.data && <AppIcon name={app.data.name} url={app.data.iconUrl} size={48} />}
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Remote config</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            Typed parameters with values per country, language, app version, acquisition source (Apple Ads campaign or organic), build or percent rollout, like Firebase Remote Config. RevflareKit fetches each device&rsquo;s values at launch (changes reach apps within about a minute plus their fetch interval) —{" "}
            <a href="https://github.com/FerdiKT/revflare/blob/main/docs/remote-config.md" target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-400">
              how it works
            </a>
            .
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/apps/${id}/experiments`} className="mr-2 text-sm font-medium text-brand-700 hover:underline dark:text-brand-400">
            Experiments
          </Link>
          <Button icon={<Download className="size-4" />} onClick={exportJson}>
            Export JSON
          </Button>
          {manage && (
            <>
              <Button icon={<Upload className="size-4" />} onClick={() => setImporting(true)}>
                Import from Firebase
              </Button>
              <Button variant="primary" icon={<Plus className="size-4" />} disabled={cfg.parameters.length >= RC_LIMITS.parameters} onClick={() => setEditParam({ original: null, p: { key: "", type: "string", defaultValue: "", conditionalValues: {} } })}>
                New parameter
              </Button>
            </>
          )}
        </div>
      </div>

      {cfg.warnings.length > 0 && (
        <div className="mb-5 space-y-1 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
          {cfg.warnings.map((w) => (
            <p key={w} className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {w}
            </p>
          ))}
        </div>
      )}

      <Card className="overflow-hidden">
        <CardHeader title="Parameters" description={`Each device gets the value of the first matching condition (in the order below), else the default. Up to ${RC_LIMITS.parameters} per app · version ${cfg.version}`} />
        {cfg.parameters.length === 0 ? (
          <EmptyState icon={<SlidersHorizontal />} title="No parameters yet" description="Add one (e.g. onboarding_version), or import your Firebase Remote Config template." />
        ) : (
          <Table>
            <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
              <tr>
                <th className={th}>Key</th>
                <th className={th}>Type</th>
                <th className={th}>Default</th>
                <th className={th}>Conditional values</th>
                <th className={th} />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {cfg.parameters.map((p) => (
                <tr key={p.key} className="align-top">
                  <td className={td}>
                    <p className="font-mono text-xs font-medium">{p.key}</p>
                    {p.description && <p className="mt-0.5 max-w-64 truncate text-xs text-zinc-500" title={p.description}>{p.description}</p>}
                  </td>
                  <td className={td}>
                    <Badge>{p.type}</Badge>
                  </td>
                  <td className={cn(td, "max-w-64 truncate font-mono text-xs")} title={p.useInAppDefault ? undefined : JSON.stringify(p.defaultValue)}>
                    {p.useInAppDefault ? <span className="font-sans text-zinc-500">in-app default</span> : showValue(p.defaultValue)}
                  </td>
                  <td className={cn(td, "whitespace-normal")}>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.keys(p.conditionalValues).length === 0 && <span className="text-xs text-zinc-400">—</span>}
                      {cfg.conditions
                        .filter((c) => c.name in p.conditionalValues)
                        .map((c) => (
                          <span key={c.name} className="inline-flex max-w-72 items-center gap-1.5 rounded-md bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800" title={JSON.stringify(p.conditionalValues[c.name])}>
                            <span className={dot(c.color)} />
                            <span className="font-medium">{c.name}</span>
                            <span className="truncate font-mono text-zinc-500">{showValue(p.conditionalValues[c.name], 40)}</span>
                            {c.unsupported && <TriangleAlert className="size-3 text-amber-500" />}
                          </span>
                        ))}
                    </div>
                  </td>
                  <td className={cn(td, "w-20 text-right")}>
                    {manage && (
                      <div className="flex justify-end">
                        <IconButton label="Edit" size="sm" onClick={() => setEditParam({ original: p.key, p })}>
                          <Pencil className="size-4" />
                        </IconButton>
                        <IconButton label="Delete" size="sm" variant="danger" disabled={busy === `param:${p.key}`} onClick={() => removeParam(p)}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="mt-5 grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <Card className="overflow-hidden">
          <CardHeader
            title="Conditions"
            description="In priority order: the first matching condition with a value wins. A condition matches when all its rules match."
            action={
              manage && (
                <Button size="sm" icon={<Plus className="size-3.5" />} disabled={cfg.conditions.length >= RC_LIMITS.conditions} onClick={() => setEditCond({ original: null, c: { name: "", rules: [{ type: "country", values: [] }] } })}>
                  Add
                </Button>
              )
            }
          />
          {cfg.conditions.length === 0 ? (
            <p className="flex items-center gap-2 border-t border-zinc-100 px-5 py-4 text-sm text-zinc-500 dark:border-zinc-800">
              <Filter className="size-4 text-zinc-400" /> No conditions: every device gets the defaults.
            </p>
          ) : (
            <ol className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
              {cfg.conditions.map((c, i) => (
                <li key={c.name} className="flex items-start gap-3 px-5 py-3">
                  <span className="mt-0.5 w-5 text-right font-mono text-xs text-zinc-400">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={dot(c.color)} />
                      <p className="text-sm font-medium">{c.name}</p>
                      {c.unsupported && (
                        <Badge tone="amber" title={c.expression}>
                          Never matches
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-500">{c.unsupported ? `Imported from Firebase, not supported: ${c.expression ?? ""}` : c.rules.map(describeRule).join(" AND ") || "Always matches"}</p>
                  </div>
                  {manage && (
                    <div className="flex items-center">
                      <IconButton label="Higher priority" size="sm" disabled={i === 0 || !!busy} onClick={() => moveCond(i, -1)}>
                        <ArrowUp className="size-4" />
                      </IconButton>
                      <IconButton label="Lower priority" size="sm" disabled={i === cfg.conditions.length - 1 || !!busy} onClick={() => moveCond(i, 1)}>
                        <ArrowDown className="size-4" />
                      </IconButton>
                      <IconButton label="Edit" size="sm" onClick={() => setEditCond({ original: c.name, c })}>
                        <Pencil className="size-4" />
                      </IconButton>
                      <IconButton label="Delete" size="sm" variant="danger" disabled={busy === `cond:${c.name}`} onClick={() => removeCond(c)}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Preview appId={id} version={cfg.version} conditions={condByName} />
      </div>

      {editParam && (
        <ParameterEditor
          key={editParam.original ?? "new"}
          initial={editParam.p}
          isNew={editParam.original === null}
          conditions={cfg.conditions}
          taken={cfg.parameters.map((p) => p.key).filter((k) => k !== editParam.original)}
          busy={busy === "param"}
          onClose={() => setEditParam(null)}
          onSave={async (p) => {
            const parameters = editParam.original === null ? [...base.parameters, p] : base.parameters.map((x) => (x.key === editParam.original ? p : x));
            if (await save("param", { ...base, parameters }, `${p.key} saved`)) setEditParam(null);
          }}
        />
      )}
      {editCond && (
        <ConditionEditor
          key={editCond.original ?? "new"}
          initial={editCond.c}
          appId={id}
          isNew={editCond.original === null}
          taken={cfg.conditions.map((c) => c.name).filter((n) => n !== editCond.original)}
          busy={busy === "cond"}
          onClose={() => setEditCond(null)}
          onSave={async (c) => {
            const old = editCond.original;
            const conditions = old === null ? [...base.conditions, c] : base.conditions.map((x) => (x.name === old ? c : x));
            // Renaming carries the parameters' values along.
            const parameters =
              old !== null && old !== c.name
                ? base.parameters.map((p) => ({ ...p, conditionalValues: Object.fromEntries(Object.entries(p.conditionalValues).map(([k, v]) => [k === old ? c.name : k, v])) }))
                : base.parameters;
            if (await save("cond", { conditions, parameters }, `Condition ${c.name} saved`)) setEditCond(null);
          }}
        />
      )}
      {importing && (
        <FirebaseImport
          appId={id}
          onClose={() => setImporting(false)}
          onDone={(res) => {
            r.setData(() => res);
            setImporting(false);
            toast.success(`Imported ${res.imported.parameters} parameters and ${res.imported.conditions} conditions`);
          }}
        />
      )}
    </>
  );
}

// --- Preview as -----------------------------------------------------------------------------------------------------

function Preview({ appId, version, conditions }: { appId: string; version: string; conditions: Map<string, RemoteConfigCondition> }) {
  const [country, setCountry] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [locale, setLocale] = useState("");
  const [installId, setInstallId] = useState("");
  const [source, setSource] = useState<InstallSource | "">("");
  const [campaign, setCampaign] = useState("");
  const [adGroup, setAdGroup] = useState("");
  const [keyword, setKeyword] = useState("");
  const [environment, setEnvironment] = useState<SdkEnvironment>("production");
  const [result, setResult] = useState<{ for: string; data: RemoteConfigEvaluation } | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const run = async () => {
    setBusy(true);
    try {
      const data = await api.apps.remoteConfig.evaluate(appId, {
        storefront: country || undefined,
        appVersion: appVersion.trim() || undefined,
        locale: locale.trim() || undefined,
        installId: installId.trim() || undefined,
        source: source || undefined,
        campaign: campaign.trim() || undefined,
        adGroup: adGroup.trim() || undefined,
        keyword: keyword.trim() || undefined,
        environment,
      });
      setResult({ for: version, data });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const keys = result ? Object.keys(result.data.parameters) : [];
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Preview as" description="The values a device gets (what GET /sdk/v1/config answers), and where each one comes from." />
      <form
        className="grid gap-3 border-t border-zinc-100 px-5 py-4 sm:grid-cols-2 dark:border-zinc-800"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <Field label="Country (storefront)">
          {(fid) => (
            <Select id={fid} value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">Unknown</option>
              {ALL_COUNTRIES.map((c) => (
                <option key={c} value={c}>
                  {flag(c)} {COUNTRY_NAMES[c]} ({c})
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="App version">{(fid) => <Input id={fid} className="font-mono text-xs" placeholder="2.1.0" value={appVersion} onChange={(e) => setAppVersion(e.target.value)} />}</Field>
        <Field label="Locale">{(fid) => <Input id={fid} className="font-mono text-xs" placeholder="zh_CN" value={locale} onChange={(e) => setLocale(e.target.value)} />}</Field>
        <Field label="Install id" help="For percent rollouts, testers and experiments.">
          {(fid) => <Input id={fid} className="font-mono text-xs" placeholder="optional" value={installId} onChange={(e) => setInstallId(e.target.value)} />}
        </Field>
        <Field label="Acquisition source" help="None: an older RevflareKit that sends no source.">
          {(fid) => (
            <Select id={fid} value={source} onChange={(e) => setSource(e.target.value as InstallSource | "")}>
              <option value="">None</option>
              {INSTALL_SOURCES.map((v) => (
                <option key={v} value={v}>
                  {SOURCE_LABELS[v]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Build">
          {(fid) => (
            <Select id={fid} value={environment} onChange={(e) => setEnvironment(e.target.value as SdkEnvironment)}>
              {SDK_ENVIRONMENTS.map((v) => (
                <option key={v} value={v}>
                  {ENV_LABELS[v]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-3 gap-2 sm:col-span-2">
          <Field label="Apple Ads campaign">{(fid) => <Input id={fid} className="font-mono text-xs" inputMode="numeric" placeholder="id" value={campaign} onChange={(e) => setCampaign(e.target.value)} />}</Field>
          <Field label="Ad group">{(fid) => <Input id={fid} className="font-mono text-xs" inputMode="numeric" placeholder="id" value={adGroup} onChange={(e) => setAdGroup(e.target.value)} />}</Field>
          <Field label="Keyword">{(fid) => <Input id={fid} className="font-mono text-xs" inputMode="numeric" placeholder="id" value={keyword} onChange={(e) => setKeyword(e.target.value)} />}</Field>
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" icon={<Eye className="size-4" />} loading={busy}>
            Preview
          </Button>
          {result && result.for !== version && <span className="ml-3 text-xs text-amber-600 dark:text-amber-400">The config changed: preview again.</span>}
        </div>
      </form>
      {result && (
        <div className="border-t border-zinc-100 dark:border-zinc-800">
          <p className="px-5 pt-3 text-xs text-zinc-500">
            Country {result.data.country ? `${flag(result.data.country)} ${result.data.country}` : "unknown"} · matches {result.data.conditions.join(", ") || "no condition"}
            {result.data.experiments?.length ? ` · experiments ${result.data.experiments.map((x) => `${x.id} (${x.variant})`).join(", ")}` : ""} · version {result.data.version}
          </p>
          {keys.length === 0 ? (
            <p className="px-5 py-3 text-sm text-zinc-500">No parameters.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <th className={th}>Key</th>
                  <th className={th}>Value</th>
                  <th className={th}>From</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                {keys.map((k) => {
                  const p = result.data.parameters[k];
                  const c = p.condition ? conditions.get(p.condition) : null;
                  return (
                    <tr key={k}>
                      <td className={cn(td, "font-mono text-xs")}>{k}</td>
                      <td className={cn(td, "max-w-56 truncate font-mono text-xs")}>{p.useInAppDefault ? <span className="font-sans text-zinc-500">in-app default (omitted)</span> : showValue(p.value)}</td>
                      <td className={cn(td, "text-xs")}>
                        {p.experiment ? (
                          <Link to={`/apps/${appId}/experiments/${p.experiment}`} className="text-brand-700 hover:underline dark:text-brand-400">
                            experiment {p.experiment}, variant {p.variant}
                          </Link>
                        ) : p.condition ? (
                          <span className="inline-flex items-center gap-1.5">
                            <span className={dot(c?.color)} /> {p.condition}
                          </span>
                        ) : (
                          <span className="text-zinc-500">default</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </div>
      )}
    </Card>
  );
}

// --- Parameter editor ----------------------------------------------------------------------------------------------

interface CondDraft {
  key: number;
  condition: string;
  inApp: boolean;
  text: string;
}
let nextKey = 1;

function ParameterEditor({
  initial,
  isNew,
  conditions,
  taken,
  busy,
  onClose,
  onSave,
}: {
  initial: RemoteConfigParameter;
  isNew: boolean;
  conditions: RemoteConfigCondition[];
  taken: string[];
  busy: boolean;
  onClose: () => void;
  onSave: (p: RemoteConfigParameter) => void;
}) {
  const [key, setKey] = useState(initial.key);
  const [type, setType] = useState<RemoteConfigValueType>(initial.type);
  const [description, setDescription] = useState(initial.description ?? "");
  const [inApp, setInApp] = useState(!!initial.useInAppDefault);
  const [text, setText] = useState(toDraft(initial.type, initial.defaultValue));
  const [conds, setConds] = useState<CondDraft[]>(() =>
    conditions
      .filter((c) => c.name in initial.conditionalValues)
      .map((c) => {
        const v = initial.conditionalValues[c.name];
        return { key: nextKey++, condition: c.name, inApp: isInApp(v), text: isInApp(v) ? toDraft(initial.type, undefined) : toDraft(initial.type, v) };
      }),
  );
  const changeType = (t: RemoteConfigValueType) => {
    // Keep what converts, reset what does not.
    const conv = (s: string) => ("value" in fromDraft(t, s) ? s : toDraft(t, undefined));
    setType(t);
    setText(conv(text));
    setConds((cs) => cs.map((c) => ({ ...c, text: conv(c.text) })));
  };
  const keyError = !key ? "Required" : !RC_PARAMETER_KEY_RE.test(key) ? "Letters, digits, _ . - (at most 128)" : taken.includes(key) ? "Already used" : null;
  const def = inApp ? null : fromDraft(type, text);
  const condValues = conds.map((c) => (c.inApp ? null : fromDraft(type, c.text)));
  const unusedConditions = conditions.filter((c) => !conds.some((x) => x.condition === c.name));
  const invalid = !!keyError || (def !== null && "error" in def) || condValues.some((v) => v !== null && "error" in v) || conds.some((c) => !c.condition);

  const submit = () => {
    const p: RemoteConfigParameter = { key, type, conditionalValues: {} };
    if (description.trim()) p.description = description.trim();
    if (inApp) p.useInAppDefault = true;
    else p.defaultValue = (def as { value: unknown }).value;
    conds.forEach((c, i) => {
      p.conditionalValues[c.condition] = c.inApp ? { useInAppDefault: true } : (condValues[i] as { value: unknown }).value;
    });
    onSave(p);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={isNew ? "New parameter" : `Edit ${initial.key}`}
      description="Devices get the value of the first matching condition (in the conditions' priority order), else the default."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={invalid} onClick={submit}>
            {isNew ? "Create" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <Field label="Key" required error={key && keyError} help={isNew ? "What the app reads, e.g. onboarding_version." : "Renaming: apps reading the old key get their in-app default."}>
            {(fid) => <Input id={fid} data-autofocus className="font-mono text-xs" placeholder="onboarding_version" value={key} invalid={!!key && !!keyError} onChange={(e) => setKey(e.target.value.trim())} />}
          </Field>
          <Field label="Type">
            {(fid) => (
              <Select id={fid} value={type} onChange={(e) => changeType(e.target.value as RemoteConfigValueType)}>
                {RC_VALUE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Description" help="Optional, for you.">
          {(fid) => <Input id={fid} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-sm font-medium">Default value</p>
            <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
              <Checkbox checked={inApp} onChange={(e) => setInApp(e.target.checked)} /> Use in-app default
            </label>
          </div>
          {inApp ? (
            <p className="rounded-lg px-3 py-2 text-xs text-zinc-500 ring-1 ring-zinc-200 dark:ring-zinc-700">The key is left out: the app uses its own default.</p>
          ) : (
            <>
              <ValueInput type={type} value={text} onChange={setText} label="Default value" invalid={def !== null && "error" in def} />
              {def && "error" in def && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{def.error}</p>}
            </>
          )}
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">Conditional values</p>
            <Button size="sm" icon={<Plus className="size-3.5" />} disabled={!unusedConditions.length} onClick={() => setConds((cs) => [...cs, { key: nextKey++, condition: unusedConditions[0].name, inApp: false, text: toDraft(type, undefined) }])}>
              Add value
            </Button>
          </div>
          {conditions.length === 0 ? (
            <p className="text-xs text-zinc-500">Add conditions first (Conditions panel), e.g. country in China.</p>
          ) : conds.length === 0 ? (
            <p className="text-xs text-zinc-500">No conditional values: every device gets the default.</p>
          ) : (
            <div className="divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-700">
              {conds
                .slice()
                .sort((a, b) => conditions.findIndex((c) => c.name === a.condition) - conditions.findIndex((c) => c.name === b.condition))
                .map((c) => {
                  const i = conds.indexOf(c);
                  const v = condValues[i];
                  const set = (patch: Partial<CondDraft>) => setConds((cs) => cs.map((x) => (x.key === c.key ? { ...x, ...patch } : x)));
                  return (
                    <div key={c.key} className="space-y-2 px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Select aria-label="Condition" className="w-52" value={c.condition} onChange={(e) => set({ condition: e.target.value })}>
                          {conditions
                            .filter((x) => x.name === c.condition || !conds.some((d) => d.condition === x.name))
                            .map((x) => (
                              <option key={x.name} value={x.name}>
                                {x.name}
                                {x.unsupported ? " (never matches)" : ""}
                              </option>
                            ))}
                        </Select>
                        <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
                          <Checkbox checked={c.inApp} onChange={(e) => set({ inApp: e.target.checked })} /> In-app default
                        </label>
                        <div className="flex-1" />
                        <IconButton label="Remove value" size="sm" variant="danger" onClick={() => setConds((cs) => cs.filter((x) => x.key !== c.key))}>
                          <Trash2 className="size-4" />
                        </IconButton>
                      </div>
                      {!c.inApp && <ValueInput type={type} value={c.text} onChange={(t) => set({ text: t })} label={`Value for ${c.condition}`} invalid={v !== null && "error" in v} />}
                      {v && "error" in v && <p className="text-xs text-red-600 dark:text-red-400">{v.error}</p>}
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// --- Condition editor ----------------------------------------------------------------------------------------------

const newRule = (type: RemoteConfigRuleType): RemoteConfigRule =>
  type === "percent" ? { type, from: 0, to: 10 } : VERSION_RULES.includes(type) ? ({ type, op: ">=", value: "" } as RemoteConfigRule) : ({ type, values: [] } as RemoteConfigRule);

function ruleError(r: RemoteConfigRule): string | null {
  if (r.type === "percent") return r.from < 0 || r.to > 100 || r.from > r.to || !Number.isFinite(r.from) || !Number.isFinite(r.to) ? "0 ≤ from ≤ to ≤ 100" : null;
  if ("values" in r) {
    if (!r.values.length) return "Add at least one value";
    if (ADS_ID_RULES.includes(r.type) && r.values.some((v) => !/^\d{1,20}$/.test(v))) return "Apple Ads ids are digits";
    return null;
  }
  return /^[0-9][0-9A-Za-z.+-]{0,31}$/.test(r.value) ? null : "A version such as 2.1.0";
}

function ConditionEditor({
  appId,
  initial,
  isNew,
  taken,
  busy,
  onClose,
  onSave,
}: {
  appId: string;
  initial: RemoteConfigCondition;
  isNew: boolean;
  taken: string[];
  busy: boolean;
  onClose: () => void;
  onSave: (c: RemoteConfigCondition) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [color, setColor] = useState<RemoteConfigConditionColor | "">(initial.color ?? "");
  const [rules, setRules] = useState<RemoteConfigRule[]>(initial.rules);
  const [keepUnsupported, setKeepUnsupported] = useState(!!initial.unsupported);
  const nameError = !name ? "Required" : !RC_CONDITION_NAME_RE.test(name) ? "Letters, digits, space _ . - (at most 64)" : taken.includes(name) ? "Already used" : null;
  const errors = rules.map(ruleError);
  const invalid = !!nameError || errors.some(Boolean);
  const setRule = (i: number, r: RemoteConfigRule) => setRules((rs) => rs.map((x, j) => (j === i ? r : x)));

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={isNew ? "New condition" : `Edit ${initial.name}`}
      description="All rules must match. Country is the App Store storefront the app reports, else the country of the request."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={invalid}
            onClick={() => onSave({ name, ...(color ? { color } : {}), rules, ...(keepUnsupported ? { unsupported: true, expression: initial.expression } : {}) })}
          >
            {isNew ? "Create" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <Field label="Name" required error={name && nameError} help={isNew ? "e.g. china, beta testers, 20% rollout" : "Renaming keeps the parameters' values."}>
            {(fid) => <Input id={fid} data-autofocus placeholder="china" value={name} invalid={!!name && !!nameError} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field label="Color">
            {(fid) => (
              <Select id={fid} value={color} onChange={(e) => setColor(e.target.value as RemoteConfigConditionColor | "")}>
                <option value="">None</option>
                {RC_CONDITION_COLORS.map((c) => (
                  <option key={c} value={c}>
                    {c.replace("_", " ")}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {initial.unsupported && (
          <div className="rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
            <p>
              Imported from Firebase with targeting Revflare cannot evaluate: <span className="font-mono">{initial.expression}</span>. It never matches until you replace it with rules below.
            </p>
            <label className="mt-2 flex items-center gap-2">
              <Checkbox checked={keepUnsupported} onChange={(e) => setKeepUnsupported(e.target.checked)} /> Keep it disabled (never matches)
            </label>
          </div>
        )}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">Rules (AND)</p>
            <Button size="sm" icon={<Plus className="size-3.5" />} disabled={rules.length >= RC_LIMITS.rulesPerCondition} onClick={() => setRules((rs) => [...rs, newRule("app_version")])}>
              Add rule
            </Button>
          </div>
          {rules.length === 0 ? (
            <p className="rounded-xl px-4 py-3 text-sm text-zinc-500 ring-1 ring-zinc-200 dark:ring-zinc-700">No rules: matches every device.</p>
          ) : (
            <div className="divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-700">
              {rules.map((r, i) => (
                <div key={i} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Select aria-label="Rule" className="w-56" value={r.type} onChange={(e) => setRule(i, newRule(e.target.value as RemoteConfigRuleType))}>
                      {(Object.keys(RULE_LABELS) as RemoteConfigRuleType[]).map((t) => (
                        <option key={t} value={t}>
                          {RULE_LABELS[t]}
                        </option>
                      ))}
                    </Select>
                    <div className="flex-1" />
                    <IconButton label="Remove rule" size="sm" variant="danger" onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                  <RuleEditor appId={appId} rule={r} onChange={(x) => setRule(i, x)} conditionName={name} />
                  {errors[i] && <p className="text-xs text-red-600 dark:text-red-400">{errors[i]}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function RuleEditor({ appId, rule, onChange, conditionName }: { appId: string; rule: RemoteConfigRule; onChange: (r: RemoteConfigRule) => void; conditionName: string }) {
  if (rule.type === "source")
    return (
      <SetPicker
        options={INSTALL_SOURCES.map((v) => ({ value: v, label: SOURCE_LABELS[v] }))}
        values={rule.values}
        onChange={(values) => onChange({ ...rule, values: values as InstallSource[] })}
        help="From RevflareKit's attribution report. Unknown: the device has no answer yet (its first launch, or Apple has not answered): it moves to Apple Ads or organic on a later launch."
      />
    );
  if (rule.type === "environment")
    return (
      <SetPicker
        options={SDK_ENVIRONMENTS.map((v) => ({ value: v, label: ENV_LABELS[v] }))}
        values={rule.values}
        onChange={(values) => onChange({ ...rule, values: values as SdkEnvironment[] })}
        help="The build the app runs in. Older RevflareKit versions count as production."
      />
    );
  if (rule.type === "apple_ads_campaign" || rule.type === "apple_ads_ad_group" || rule.type === "apple_ads_keyword") return <AdsIdPicker appId={appId} rule={rule} onChange={onChange} />;
  if (rule.type === "percent")
    return (
      <div className="grid grid-cols-[auto_6rem_auto_6rem_1fr] items-center gap-2 text-sm">
        <span className="text-zinc-500">Installs in bucket</span>
        <Input aria-label="From percent" type="number" min={0} max={100} step="any" value={rule.from} onChange={(e) => onChange({ ...rule, from: Number(e.target.value) })} />
        <span className="text-zinc-500">to</span>
        <Input aria-label="To percent" type="number" min={0} max={100} step="any" value={rule.to} onChange={(e) => onChange({ ...rule, to: Number(e.target.value) })} />
        <Input
          aria-label="Seed"
          className="font-mono text-xs"
          placeholder={`seed: ${conditionName || "condition name"}`}
          value={rule.seed ?? ""}
          onChange={(e) => {
            const { seed: _, ...rest } = rule;
            onChange(e.target.value ? { ...rest, seed: e.target.value } : rest);
          }}
        />
        <p className="col-span-5 text-xs text-zinc-500">
          {Math.max(0, rule.to - rule.from)}% of installs, stable per install (sha256 of the install id and the seed). Same seed and ranges side by side split users without overlap.
        </p>
      </div>
    );
  if ("op" in rule)
    return (
      <div className="grid grid-cols-[6rem_10rem_1fr] items-center gap-2">
        <Select aria-label="Operator" value={rule.op} onChange={(e) => onChange({ ...rule, op: e.target.value as RemoteConfigVersionOp })}>
          {RC_VERSION_OPS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
        <Input aria-label="Version" className="font-mono text-xs" placeholder="2.1.0" value={rule.value} onChange={(e) => onChange({ ...rule, value: e.target.value.trim() })} />
        <span className="text-xs text-zinc-500">Semantic: 2.10 &gt; 2.9</span>
      </div>
    );
  if (COUNTRY_RULES.includes(rule.type)) return <CountryPicker values={rule.values} onChange={(values) => onChange({ ...rule, values })} />;
  return <ListInput rule={rule} onChange={onChange} />;
}

function SetPicker({ options, values, onChange, help }: { options: { value: string; label: string }[]; values: string[]; onChange: (v: string[]) => void; help: string }) {
  return (
    <div>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        {options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm">
            <Checkbox checked={values.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...values, o.value] : values.filter((v) => v !== o.value))} /> {o.label}
          </label>
        ))}
      </div>
      <p className="mt-1 text-xs text-zinc-500">{help}</p>
    </div>
  );
}

/** Apple Ads ids: the ids seen in the app's installs over 30 days (with install counts), plus free entry. */
function AdsIdPicker({ appId, rule, onChange }: { appId: string; rule: StringListRule; onChange: (r: RemoteConfigRule) => void }) {
  const opts = useFetch(`rc-attribution-options:${appId}`, () => api.apps.remoteConfig.attributionOptions(appId));
  const list =
    rule.type === "apple_ads_campaign"
      ? (opts.data?.campaigns ?? []).map((x) => ({ id: x.id, name: x.name, installs: x.installs, parent: null as string | null }))
      : rule.type === "apple_ads_ad_group"
        ? (opts.data?.adGroups ?? []).map((x) => ({ id: x.id, name: x.name, installs: x.installs, parent: x.campaignId ? `campaign ${x.campaignId}` : null }))
        : (opts.data?.keywords ?? []).map((x) => ({ id: x.id, name: x.name, installs: x.installs, parent: x.adGroupId ? `ad group ${x.adGroupId}` : null }));
  // The text field is rebuilt from the values when a checkbox changes them (not while typing).
  const [rev, setRev] = useState(0);
  const toggle = (id: string, on: boolean) => {
    onChange({ ...rule, values: on ? [...rule.values, id] : rule.values.filter((v) => v !== id) });
    setRev((n) => n + 1);
  };
  return (
    <div className="space-y-2">
      {opts.error ? (
        <p className="text-xs text-red-600 dark:text-red-400">Could not load the ids seen in installs.</p>
      ) : !opts.data ? (
        <Skeleton className="h-10" />
      ) : list.length === 0 ? (
        <p className="text-xs text-zinc-500">No Apple Ads installs reported in the last 30 days: enter ids below.</p>
      ) : (
        <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg px-3 py-2 ring-1 ring-zinc-200 dark:ring-zinc-700">
          {list.map((x) => (
            <label key={x.id} className="flex items-center gap-2 text-sm">
              <Checkbox checked={rule.values.includes(x.id)} onChange={(e) => toggle(x.id, e.target.checked)} />
              <span className="font-mono text-xs">{x.id}</span>
              {x.name && <span className="truncate">{x.name}</span>}
              {x.parent && <span className="text-xs text-zinc-400">{x.parent}</span>}
              <span className="ml-auto text-xs tabular-nums text-zinc-500">{x.installs} installs</span>
            </label>
          ))}
        </div>
      )}
      <ListInput key={rev} rule={rule} onChange={onChange} />
    </div>
  );
}

function ListInput({ rule, onChange }: { rule: StringListRule; onChange: (r: RemoteConfigRule) => void }) {
  const [text, setText] = useState(rule.values.join(", "));
  const placeholder =
    rule.type === "language" ? "zh, tr, en" : rule.type === "locale" ? "zh_CN, en_US" : ADS_ID_RULES.includes(rule.type) ? "Apple Ads ids (digits), comma separated" : "install ids (RevflareKit), one per line or comma separated";
  return (
    <div>
      <Textarea
        aria-label="Values"
        rows={rule.type === "install_id" ? 3 : 1}
        className="font-mono text-xs"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange({
            ...rule,
            values: e.target.value
              .split(/[\s,]+/)
              .map((s) => s.trim())
              .filter(Boolean),
          });
        }}
      />
      <p className="mt-1 text-xs text-zinc-500">
        {rule.type === "language"
          ? "Language of the device locale: zh matches zh_CN and zh-Hans_TW."
          : rule.type === "locale"
            ? "Device locale: en_US (- and _ are the same)."
            : ADS_ID_RULES.includes(rule.type)
              ? "Matches installs Apple attributed to one of these ids (RevflareKit sends them from its attribution report)."
              : "Matches these installs exactly (testers)."}
      </p>
    </div>
  );
}

function CountryPicker({ values, onChange }: { values: string[]; onChange: (v: string[]) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(values.length === 0);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? ALL_COUNTRIES.filter((c) => c.toLowerCase() === s || COUNTRY_NAMES[c].toLowerCase().includes(s)) : ALL_COUNTRIES;
  }, [q]);
  const toggle = (c: string) => onChange(values.includes(c) ? values.filter((x) => x !== c) : [...values, c]);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {values.map((c) => (
          <span key={c} className="inline-flex items-center gap-1 rounded-md bg-zinc-100 py-0.5 pr-1 pl-2 text-xs dark:bg-zinc-800">
            {flag(c)} {COUNTRY_NAMES[c] ?? c}
            <button type="button" aria-label={`Remove ${c}`} className="rounded p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" onClick={() => toggle(c)}>
              <X className="size-3" />
            </button>
          </span>
        ))}
        <Button size="sm" variant="ghost" icon={open ? undefined : <Plus className="size-3.5" />} aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Done" : values.length ? "Countries" : "Add countries"}
        </Button>
      </div>
      {open && (
        <div className="rounded-xl ring-1 ring-zinc-200 dark:ring-zinc-700">
          <div className="border-b border-zinc-100 p-2 dark:border-zinc-800">
            <Input aria-label="Search countries" placeholder="Search countries (name or code)…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <ul className="max-h-56 overflow-auto py-1">
            {list.map((c) => (
              <li key={c}>
                <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/60">
                  <Checkbox checked={values.includes(c)} onChange={() => toggle(c)} />
                  <span>{flag(c)}</span>
                  <span className="min-w-0 flex-1 truncate">{COUNTRY_NAMES[c]}</span>
                  <span className="font-mono text-xs text-zinc-400">{c}</span>
                </label>
              </li>
            ))}
            {list.length === 0 && <li className="px-3 py-2 text-sm text-zinc-500">No country matches.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

// --- Firebase import -----------------------------------------------------------------------------------------------

function FirebaseImport({ appId, onClose, onDone }: { appId: string; onClose: () => void; onDone: (r: RemoteConfigImport) => void }) {
  const [text, setText] = useState("");
  const [merge, setMerge] = useState(false);
  const [preview, setPreview] = useState<{ text: string; merge: boolean; data: RemoteConfigImport } | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  let parsed: unknown = undefined;
  let parseError: string | null = null;
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parseError = (e as Error).message;
    }
  }
  const call = async (dryRun: boolean) => {
    setBusy(dryRun ? "preview" : "apply");
    setError(null);
    try {
      const data = await api.apps.remoteConfig.importFirebase(appId, parsed, { dryRun, merge });
      if (dryRun) setPreview({ text, merge, data });
      else onDone(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (!dryRun) toast.error(err);
    } finally {
      setBusy(null);
    }
  };
  const fresh = preview && preview.text === text && preview.merge === merge;
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title="Import from Firebase"
      description={
        <>
          Paste or upload the template JSON from <span className="font-mono">firebase remoteconfig:get -o template.json</span> (or the Remote Config REST API). Conditions Revflare cannot evaluate are imported as conditions that never match.
        </>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy === "preview"} disabled={!parsed || !!busy} onClick={() => call(true)}>
            Preview
          </Button>
          <Button variant="primary" loading={busy === "apply"} disabled={!fresh || !!busy} onClick={() => call(false)}>
            {merge ? "Merge" : "Replace config"}
          </Button>
        </>
      }
    >
      <div className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-1.5 text-sm ring-1 ring-zinc-200 hover:bg-zinc-50 dark:ring-zinc-700 dark:hover:bg-zinc-800">
            <Upload className="size-4" /> Upload file
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setText(await f.text());
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
            <Checkbox checked={merge} onChange={(e) => setMerge(e.target.checked)} /> Merge into the current config (parameters by key, conditions by name) instead of replacing it
          </label>
        </div>
        <Textarea aria-label="Firebase template JSON" rows={8} spellCheck={false} className="font-mono text-xs" placeholder={'{ "conditions": [...], "parameters": {...}, "parameterGroups": {...} }'} value={text} invalid={!!parseError} onChange={(e) => setText(e.target.value)} />
        {parseError && <p className="text-xs text-red-600 dark:text-red-400">Not valid JSON: {parseError}</p>}
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {preview && (
          <div className={cn("space-y-3 rounded-xl p-4 ring-1 ring-zinc-200 dark:ring-zinc-700", !fresh && "opacity-60")}>
            <p className="text-sm">
              {preview.data.imported.parameters} parameters and {preview.data.imported.conditions} conditions
              {preview.data.imported.unsupportedConditions ? ` (${preview.data.imported.unsupportedConditions} unsupported)` : ""} → the config will have {preview.data.parameters.length} parameters and {preview.data.conditions.length} conditions.
              {!fresh && " Changed since the preview: preview again."}
            </p>
            {preview.data.warnings.length > 0 && (
              <ul className="space-y-1 text-xs text-amber-800 dark:text-amber-300">
                {preview.data.warnings.map((w) => (
                  <li key={w} className="flex items-start gap-1.5">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {w}
                  </li>
                ))}
              </ul>
            )}
            <div className="max-h-56 overflow-auto">
              <Table>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {preview.data.parameters.map((p) => (
                    <tr key={p.key}>
                      <td className={cn(td, "py-1.5 font-mono text-xs")}>{p.key}</td>
                      <td className={cn(td, "py-1.5 text-xs")}>{p.type}</td>
                      <td className={cn(td, "max-w-60 truncate py-1.5 font-mono text-xs")}>{p.useInAppDefault ? "in-app default" : showValue(p.defaultValue)}</td>
                      <td className={cn(td, "py-1.5 text-xs text-zinc-500")}>{Object.keys(p.conditionalValues).join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

