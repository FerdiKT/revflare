import { useMemo, useState } from "react";
import { Link } from "react-router";
import { Gem } from "lucide-react";
import type { InstallSource, Ltv, LtvCohortUnit, LtvDimension, LtvGroup, LtvHorizon, LtvSummaryRow } from "@shared/types";
import { FilterBar } from "../components/FilterBar";
import { Select } from "../components/ui/Form";
import { Card, CardHeader, EmptyState, ErrorState, PageHeader, Segmented, Skeleton, Stat, Table, td, th } from "../components/ui/Misc";
import { api } from "../lib/api";
import { useFilters } from "../lib/filters";
import { SOURCE_LABELS, cn, countryLabel, fullNumber, money, monthLabel, percent, shortDay } from "../lib/format";
import { useFetch } from "../lib/useFetch";

type Value = "revenue" | "proceeds";

const DIMENSIONS: { value: LtvDimension; label: string }[] = [
  { value: "source", label: "Source" },
  { value: "campaign", label: "Campaign" },
  { value: "adgroup", label: "Ad group" },
  { value: "keyword", label: "Keyword" },
  { value: "country", label: "Country" },
];

const RANGES = [
  { value: "90d", label: "Last 90 days" },
  { value: "182d", label: "Last 26 weeks" },
  { value: "13m", label: "Last 13 months" },
];

const ALL = "__all";
const horizonLabel = (d: number | null) => (d === null ? "To date" : `D${d}`);

/** Readable name of a group: Apple Ads / Organic, campaign, ad group, keyword or country. */
function groupName(g: LtvGroup, by: LtvDimension): { name: string; sub?: string } {
  if (g.group === "organic") return { name: "Organic" };
  if (by === "source") return { name: SOURCE_LABELS[g.group as InstallSource] ?? g.group };
  if (by === "country") return { name: g.country ? countryLabel(g.country) : "Unknown" };
  if (by === "campaign") return { name: g.campaignId ? `Campaign ${g.campaignId}` : "Unknown campaign" };
  if (by === "adgroup") return { name: g.adGroupId ? `Ad group ${g.adGroupId}` : "No ad group", sub: g.campaignId ? `Campaign ${g.campaignId}` : undefined };
  return { name: g.keywordId ? `Keyword ${g.keywordId}` : "No keyword", sub: [g.campaignId && `Campaign ${g.campaignId}`, g.adGroupId && `ad group ${g.adGroupId}`].filter(Boolean).join(" · ") || undefined };
}

interface CohortLine {
  cohort: string;
  installs: number;
  payers: number;
  horizons: LtvHorizon[];
}

/** One line per cohort: the chosen group's rows, or all groups pooled (installs-weighted). */
function cohortLines(d: Ltv, group: string): CohortLine[] {
  if (group !== ALL) return d.rows.filter((r) => r.group === group);
  const byCohort = new Map<string, Ltv["rows"]>();
  for (const r of d.rows) byCohort.set(r.cohort, [...(byCohort.get(r.cohort) ?? []), r]);
  return [...byCohort.entries()].map(([cohort, rows]) => {
    const installs = rows.reduce((s, r) => s + r.installs, 0);
    const horizons = rows[0].horizons.map((h0, i): LtvHorizon => {
      if (h0.immature) return h0;
      const sum = (k: "revenuePerInstall" | "proceedsPerInstall") => rows.reduce((s, r) => s + (r.horizons[i][k] ?? 0) * r.installs, 0) / installs;
      return { day: h0.day, immature: false, revenuePerInstall: sum("revenuePerInstall"), proceedsPerInstall: sum("proceedsPerInstall"), payers: rows.reduce((s, r) => s + (r.horizons[i].payers ?? 0), 0) };
    });
    return { cohort, installs, payers: rows.reduce((s, r) => s + r.payers, 0), horizons };
  });
}

function cohortLabel(cohort: string, unit: LtvCohortUnit) {
  if (unit === "month") return monthLabel(cohort);
  return unit === "week" ? `Week of ${shortDay(cohort)}` : shortDay(cohort);
}

export function LtvPage() {
  const { apps } = useFilters();
  const [by, setBy] = useState<LtvDimension>("source");
  const [cohort, setCohort] = useState<LtvCohortUnit>("week");
  const [range, setRange] = useState("182d");
  const [value, setValue] = useState<Value>("revenue");
  const [group, setGroup] = useState(ALL);
  const scope = { apps, range };
  // One request for both tables: the cohorts and, pooled over the same installs, the summary per group.
  const r = useFetch(`ltv:${apps.join()}:${by}:${cohort}:${range}`, () => api.ltv({ ...scope, by, cohort, summary: 1 }), { tags: ["metrics"] });
  const d = r.data;
  const sum = d?.summary ? { ...d, rows: d.summary } : undefined;
  const k = value === "revenue" ? "revenuePerInstall" : "proceedsPerInstall";

  const groups = useMemo(() => sum?.rows ?? [], [sum]);
  const shown = group === ALL || groups.some((g) => g.group === group) ? group : ALL;
  const lines = useMemo(() => (d ? cohortLines(d, shown) : []), [d, shown]);
  const totals = useMemo(() => totalsOf(sum), [sum]);

  const changeBy = (v: LtvDimension) => {
    setBy(v);
    setGroup(ALL);
  };
  const fmt = (v: number | null | undefined, currency: string) => (v === null || v === undefined ? "—" : money(v, currency, { cents: true }));
  const empty = d && d.coverage.installs === 0;

  return (
    <>
      <PageHeader title="LTV" description="What an install is worth: revenue per install in the days after install, by install cohort and acquisition source (RevflareKit)." />
      <FilterBar>
        <Select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Installs" className="w-44">
          {RANGES.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </Select>
        <Select value={by} onChange={(e) => changeBy(e.target.value as LtvDimension)} aria-label="Group by" className="w-40">
          {DIMENSIONS.map((x) => (
            <option key={x.value} value={x.value}>
              By {x.label.toLowerCase()}
            </option>
          ))}
        </Select>
        <div className="flex-1" />
        <Segmented
          label="Value"
          value={value}
          onChange={setValue}
          options={[
            { value: "revenue", label: "Revenue", title: "Customer price, refunds excluded" },
            { value: "proceeds", label: "Proceeds", title: "What Apple pays out" },
          ]}
        />
      </FilterBar>
      {r.error && <ErrorState error={r.error} onRetry={() => r.refetch()} className="mb-5" />}

      {empty ? (
        <Card>
          <EmptyState
            icon={<Gem />}
            title="No installs are reporting yet"
            description={
              <p>
                LTV follows installs that report to <strong>RevflareKit</strong>. Add the Swift package and call <code className="font-mono text-xs">Revflare.configure(sdkKey:server:)</code> at launch; the SDK key is on
                the app&rsquo;s page under Apps.
              </p>
            }
            action={
              <Link
                to="/apps"
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-white px-3.5 text-sm font-medium text-zinc-800 shadow-sm ring-1 ring-zinc-200 hover:bg-zinc-50 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700"
              >
                Open Apps
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="p-5">
              {sum ? (
                <Stat
                  label="Installs"
                  value={fullNumber(totals.installs)}
                  sub={`${fullNumber(sum.coverage.attributed)} from Apple Ads${sum.coverage.preexisting ? ` · ${fullNumber(sum.coverage.preexisting)} earlier users not counted` : ""}`}
                />
              ) : (
                <Skeleton className="h-16" />
              )}
            </Card>
            <Card className="p-5">
              {sum ? <Stat label="Payers" value={fullNumber(totals.payers)} sub={totals.installs ? `${percent(totals.payers / totals.installs)} of installs paid` : "No installs"} /> : <Skeleton className="h-16" />}
            </Card>
            <Card className="p-5">
              {sum ? (
                <Stat
                  label={`D30 ${value} per install`}
                  value={totals.d30 ? fmt(totals.d30[k], sum.currency) : "—"}
                  sub={totals.d30 ? `${fullNumber(totals.d30.installs)} installs at least 31 days old` : "No install is 31 days old yet"}
                />
              ) : (
                <Skeleton className="h-16" />
              )}
            </Card>
            <Card className="p-5">
              {sum ? (
                <Stat
                  label="Coverage"
                  value={sum.coverage.share === null ? "—" : percent(sum.coverage.share)}
                  sub={`${fullNumber(sum.coverage.linkedCustomers)} of ${fullNumber(sum.coverage.payingCustomers)} paying customers linked to an install`}
                />
              ) : (
                <Skeleton className="h-16" />
              )}
            </Card>
          </div>

          <Card className="mt-5 overflow-hidden">
            <CardHeader
              title={`By ${DIMENSIONS.find((x) => x.value === by)!.label.toLowerCase()}`}
              description={`${value === "revenue" ? "Revenue" : "Proceeds"} per install, pooled over the installs old enough for each horizon. — = no install that old yet.`}
            />
            {!sum ? (
              <div className="space-y-2 px-5 pb-5">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : groups.length === 0 ? (
              <p className="px-5 pb-8 text-center text-sm text-zinc-500">No installs in this range.</p>
            ) : (
              <Table>
                <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
                  <tr>
                    <th className={th}>{DIMENSIONS.find((x) => x.value === by)!.label}</th>
                    <th className={cn(th, "text-right")}>Installs</th>
                    <th className={cn(th, "text-right")}>Payers</th>
                    <th className={cn(th, "text-right")}>Conversion</th>
                    {sum.horizons.map((h) => (
                      <th key={h} className={cn(th, "text-right")}>
                        {horizonLabel(h)}
                      </th>
                    ))}
                    <th className={cn(th, "text-right")}>To date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {groups.map((g) => {
                    const n = groupName(g, by);
                    return (
                      <tr
                        key={g.group}
                        className={cn("cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40", shown === g.group && "bg-zinc-50 dark:bg-zinc-800/40")}
                        onClick={() => setGroup(shown === g.group ? ALL : g.group)}
                        title="Show this group's cohorts below"
                      >
                        <td className={td}>
                          <span className={cn("font-medium", g.group === "organic" && "text-zinc-600 dark:text-zinc-300")}>{n.name}</span>
                          {n.sub && <span className="ml-2 text-xs text-zinc-400">{n.sub}</span>}
                        </td>
                        <td className={cn(td, "text-right tabular-nums")}>{fullNumber(g.installs)}</td>
                        <td className={cn(td, "text-right tabular-nums")}>{fullNumber(g.payers)}</td>
                        <td className={cn(td, "text-right tabular-nums")}>{g.conversion === null ? "—" : percent(g.conversion)}</td>
                        {g.horizons.map((h) => (
                          <td
                            key={h.day}
                            className={cn(td, "text-right tabular-nums", h.immature && "text-zinc-400")}
                            title={h.immature ? `No install ${h.day} days old yet` : `${fullNumber(h.installs)} installs, ${fullNumber(h.payers ?? 0)} payers`}
                          >
                            {fmt(h[k], sum.currency)}
                          </td>
                        ))}
                        <td className={cn(td, "text-right font-medium tabular-nums")}>{g.installs ? fmt((value === "revenue" ? g.revenue : g.proceeds) / g.installs, sum.currency) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
          </Card>

          <Card className="mt-5 overflow-hidden">
            <CardHeader
              title="Cohorts"
              description="Installs by install date, followed day by day after install. Grey cells: the cohort is not that old yet."
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={shown} onChange={(e) => setGroup(e.target.value)} aria-label="Group" className="w-48">
                    <option value={ALL}>All installs</option>
                    {groups.map((g) => (
                      <option key={g.group} value={g.group}>
                        {groupName(g, by).name}
                      </option>
                    ))}
                  </Select>
                  <Segmented
                    size="sm"
                    label="Cohort"
                    value={cohort}
                    onChange={setCohort}
                    options={[
                      { value: "day", label: "Day" },
                      { value: "week", label: "Week" },
                      { value: "month", label: "Month" },
                    ]}
                  />
                </div>
              }
            />
            {!d ? (
              <div className="space-y-1.5 p-5">
                {Array.from({ length: 8 }, (_, i) => (
                  <Skeleton key={i} className="h-9" />
                ))}
              </div>
            ) : lines.length === 0 ? (
              <p className="px-5 pb-8 text-center text-sm text-zinc-500">No installs in this range.</p>
            ) : (
              <CohortTable lines={lines} unit={d.cohort} horizons={d.horizons} k={k} currency={d.currency} />
            )}
          </Card>
          {d && sum && (
            <p className="mt-3 text-xs text-zinc-500">
              D0 = the first 24 hours after install, Dn = the first n days. Refunds are excluded (prorated refunds in part); purchases that started more than 48 hours before the install are not counted
              {sum.coverage.preexisting
                ? `, and ${fullNumber(sum.coverage.preexisting)} installs whose purchases all predate them (users who had the app before) are left out of installs and values`
                : ""}
              . Cohorts are UTC days. Coverage:{" "}
              {sum.coverage.share === null ? "no paying customer in this range yet" : `${percent(sum.coverage.share)} of paying customers are linked to a reporting install, the rest is missing from these values`}.
              Amounts in {d.currency}.
            </p>
          )}
        </>
      )}
    </>
  );
}

function totalsOf(sum: { horizons: number[]; rows: LtvSummaryRow[] } | undefined) {
  const installs = sum?.rows.reduce((s, r) => s + r.installs, 0) ?? 0;
  const payers = sum?.rows.reduce((s, r) => s + r.payers, 0) ?? 0;
  let d30: { installs: number; revenuePerInstall: number; proceedsPerInstall: number } | null = null;
  const i = sum?.horizons.indexOf(30) ?? -1;
  if (sum && i >= 0) {
    let n = 0;
    let rev = 0;
    let net = 0;
    for (const r of sum.rows) {
      const h = r.horizons[i];
      if (h.immature) continue;
      n += h.installs;
      rev += (h.revenuePerInstall ?? 0) * h.installs;
      net += (h.proceedsPerInstall ?? 0) * h.installs;
    }
    if (n) d30 = { installs: n, revenuePerInstall: rev / n, proceedsPerInstall: net / n };
  }
  return { installs, payers, d30 };
}

function CohortTable({ lines, unit, horizons, k, currency }: { lines: CohortLine[]; unit: LtvCohortUnit; horizons: number[]; k: "revenuePerInstall" | "proceedsPerInstall"; currency: string }) {
  const days: (number | null)[] = [...horizons, null];
  // Shading compares cohorts within a column (later horizons are always higher).
  const ranges = days.map((_, i) => {
    let min = Infinity;
    let max = -Infinity;
    for (const l of lines) {
      const v = l.horizons[i]?.[k];
      if (v === null || v === undefined) continue;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    return { min, max };
  });
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full min-w-max border-separate border-spacing-[3px] p-3 text-sm" aria-label="Value per install by install cohort and days since install">
        <thead>
          <tr>
            <th className="sticky left-0 z-10 bg-white px-3 py-2 text-left text-xs font-medium text-zinc-500 dark:bg-zinc-900">Cohort</th>
            <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Installs</th>
            <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Payers</th>
            {days.map((x) => (
              <th key={String(x)} className="px-2 py-2 text-center text-xs font-medium text-zinc-500">
                {horizonLabel(x)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.cohort}>
              <th scope="row" className="sticky left-0 z-10 bg-white px-3 py-1.5 text-left font-medium whitespace-nowrap dark:bg-zinc-900">
                {cohortLabel(l.cohort, unit)}
              </th>
              <td className="px-3 py-1.5 text-right text-zinc-600 tabular-nums dark:text-zinc-300">{fullNumber(l.installs)}</td>
              <td className="px-3 py-1.5 text-right text-zinc-600 tabular-nums dark:text-zinc-300">{fullNumber(l.payers)}</td>
              {days.map((x, i) => {
                const h = l.horizons[i];
                const v = h?.[k];
                if (!h || h.immature || v === null || v === undefined)
                  return (
                    <td key={String(x)} title={x === null ? `${cohortLabel(l.cohort, unit)}: no value yet` : `${cohortLabel(l.cohort, unit)}: not ${x} days old yet`} className="min-w-20 rounded-md bg-zinc-100 px-2 py-1.5 text-center text-xs text-zinc-400 dark:bg-zinc-800/60 dark:text-zinc-500">
                      —
                    </td>
                  );
                const { min, max } = ranges[i];
                const p = max > min ? Math.round(6 + ((v - min) / (max - min)) * 94) : 50;
                return (
                  <td
                    key={String(x)}
                    title={`${cohortLabel(l.cohort, unit)}, ${horizonLabel(x)}: ${money(v, currency, { cents: true })} per install (${fullNumber(h.payers ?? 0)} of ${fullNumber(l.installs)} installs paid)`}
                    className={cn("min-w-20 rounded-md px-2 py-1.5 text-center text-xs font-medium tabular-nums", p > 62 ? "text-white" : "text-zinc-800 dark:text-zinc-100")}
                    style={{ backgroundColor: `color-mix(in oklab, var(--viz-seq) ${p}%, var(--viz-surface))` }}
                  >
                    {money(v, currency, { cents: true })}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
