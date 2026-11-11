import { Fragment, useMemo, useState } from "react";
import { Link } from "react-router";
import { ChevronRight, Megaphone, Tags } from "lucide-react";
import type { AttributedRevenue, Interval } from "@shared/types";
import { AdsNamesDialog } from "../components/AdsNamesDialog";
import { ChartSkeleton, Legend, OTHER_COLOR, PALETTE, TimeChart } from "../components/charts";
import { FilterBar } from "../components/FilterBar";
import { AppIcon } from "../components/Logo";
import { AppleOnlyNotice } from "../components/Platform";
import { Button } from "../components/ui/Button";
import { Switch } from "../components/ui/Form";
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader, Skeleton, Stat, Table, td, th } from "../components/ui/Misc";
import { api } from "../lib/api";
import { useApps } from "../lib/apps";
import { addDays, useFilters } from "../lib/filters";
import { cn, formatAxis, fullNumber, money, percent } from "../lib/format";
import { useFetch } from "../lib/useFetch";

type Row = AttributedRevenue["rows"][number];

interface Totals {
  revenue: number;
  proceeds: number;
  transactions: number;
  trials: number;
  installs: number;
  payers: number;
}

interface Node extends Totals {
  key: string;
  id: string | null;
  /** Name from PUT /attribution/names (null: shown as "#<id>"). */
  name: string | null;
  /** Test data (only with "Include test data"). */
  test: boolean;
  appIds: Set<string>;
  children: Map<string, Node>;
}

const zero = (): Totals => ({ revenue: 0, proceeds: 0, transactions: 0, trials: 0, installs: 0, payers: 0 });

function add(t: Totals, r: Totals) {
  t.revenue += r.revenue;
  t.proceeds += r.proceeds;
  t.transactions += r.transactions;
  t.trials += r.trials;
  t.installs += r.installs;
  t.payers += r.payers;
}

function node(parent: Map<string, Node>, key: string, id: string | null, name: string | null | undefined, test: boolean): Node {
  let n = parent.get(key);
  if (!n) {
    n = { key, id, name: name ?? null, test, appIds: new Set(), children: new Map(), ...zero() };
    parent.set(key, n);
  }
  return n;
}

/** A campaign / ad group / keyword: its name, else "#<id>". */
const label = (n: { id: string | null; name: string | null }) => n.name || (n.id ? `#${n.id}` : null);

/** Campaign → ad group → keyword tree with totals at every level, biggest revenue first. */
function buildTree(rows: Row[]): Node[] {
  const root = new Map<string, Node>();
  for (const r of rows) {
    // Test rows (Apple's test payload, sandbox builds, test devices) stay apart from production ones.
    const t = r.test ? "test|" : "";
    const test = !!r.test;
    const c = node(root, `${t}${r.campaignId}`, r.campaignId, r.campaignName, test);
    const g = node(c.children, `${t}${r.campaignId}|${r.adGroupId ?? ""}`, r.adGroupId, r.adGroupName, test);
    const k = node(g.children, `${t}${r.campaignId}|${r.adGroupId ?? ""}|${r.keywordId ?? ""}`, r.keywordId, r.keywordName, test);
    for (const n of [c, g, k]) {
      add(n, r);
      n.appIds.add(r.appId);
    }
  }
  return sortNodes(root);
}

function sortNodes(m: Map<string, Node>): Node[] {
  return [...m.values()].sort((a, b) => b.revenue - a.revenue || b.installs - a.installs);
}

function chartInterval(from: string, to: string): Interval {
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  return days > 400 ? "month" : days > 120 ? "week" : "day";
}

function bucket(day: string, interval: Interval): string {
  if (interval === "month") return day.slice(0, 7);
  if (interval === "week") {
    const d = new Date(`${day}T00:00:00Z`);
    return addDays(day, -((d.getUTCDay() + 6) % 7));
  }
  return day;
}

const TOP_CAMPAIGNS = 5;

export function AppleAdsPage() {
  const { scope, apps, range, from, to } = useFilters();
  const { byId } = useApps();
  const [includeTest, setIncludeTest] = useState(false);
  const [namesOpen, setNamesOpen] = useState(false);
  const r = useFetch(`attributed:${apps.join()}:${range}:${from}:${to}:${includeTest}`, () => api.attributed({ ...scope, includeTest }), { tags: ["metrics"] });
  const d = r.data;
  const [open, setOpen] = useState<Set<string>>(new Set());

  const tree = useMemo(() => (d ? buildTree(d.rows) : []), [d]);
  const totals = useMemo(() => {
    const t = zero();
    for (const row of d?.rows ?? []) add(t, row);
    return t;
  }, [d]);

  const chart = useMemo(() => {
    if (!d || !d.rows.length) return null;
    // "All time" starts in 2015: begin the chart at the first attributed day instead.
    const first = d.rows.reduce((m, x) => (x.date < m ? x.date : m), d.to);
    const start = d.from < first ? first : d.from;
    const interval = chartInterval(start, d.to);
    const dates: string[] = [];
    for (let day = start; day <= d.to; day = addDays(day, 1)) {
      const b = bucket(day, interval);
      if (dates[dates.length - 1] !== b) dates.push(b);
    }
    const index = new Map(dates.map((x, i) => [x, i]));
    const top = tree.filter((c) => c.revenue > 0).slice(0, TOP_CAMPAIGNS);
    const topKeys = new Set(top.map((c) => c.key));
    const values = new Map<string, number[]>([...top.map((c) => [c.key, dates.map(() => 0)] as const), ["other", dates.map(() => 0)]]);
    for (const x of d.rows) {
      const i = index.get(bucket(x.date, interval));
      if (i === undefined) continue;
      const k = `${x.test ? "test|" : ""}${x.campaignId}`;
      values.get(topKeys.has(k) ? k : "other")![i] += x.revenue;
    }
    const series = top.map((c, i) => ({ key: c.key, label: `${label(c)}${c.test ? " (test)" : ""}`, color: PALETTE[i % PALETTE.length], values: values.get(c.key)! }));
    const other = values.get("other")!;
    if (other.some((v) => v)) series.push({ key: "other", label: "Other campaigns", color: OTHER_COLOR, values: other });
    return { dates, interval, series };
  }, [d, tree]);

  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const expandAll = () => setOpen(new Set(tree.flatMap((c) => [c.key, ...[...c.children.values()].map((g) => g.key)])));
  const allOpen = tree.length > 0 && tree.every((c) => open.has(c.key));

  const coverage = d?.coverage;
  const share = coverage && coverage.installs ? coverage.attributed / coverage.installs : null;
  const empty = d && d.rows.length === 0;
  const androidOnly = apps.length > 0 && apps.every((id) => byId.get(id)?.platform === "android");

  if (androidOnly)
    return (
      <>
        <PageHeader title="Apple Ads" description="Revenue of installs Apple attributed to Apple Ads, by campaign, ad group and keyword (RevflareKit)." />
        <FilterBar range />
        <AppleOnlyNotice what="Apple Ads attribution and campaign reports" />
      </>
    );

  return (
    <>
      <PageHeader
        title="Apple Ads"
        description="Revenue of installs Apple attributed to Apple Ads, by campaign, ad group and keyword (RevflareKit)."
        actions={
          <Button size="sm" variant="outline" icon={<Tags className="size-3.5" />} onClick={() => setNamesOpen(true)}>
            Names
          </Button>
        }
      />
      <FilterBar range>
        <label
          className="inline-flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400"
          title="By default, Apple's test attribution (AdServices test payload), sandbox / Xcode builds and the apps' test devices are left out."
        >
          <Switch label="Include test data" checked={includeTest} onChange={setIncludeTest} />
          Include test data
        </label>
      </FilterBar>
      <AdsNamesDialog open={namesOpen} onClose={() => setNamesOpen(false)} onChanged={() => r.refetch()} />
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-5" />}

      {empty && coverage && coverage.installs === 0 ? (
        <Card>
          <EmptyState
            icon={<Megaphone />}
            title="No installs are reporting yet"
            description={
              <>
                <p>
                  Add the <strong>RevflareKit</strong> Swift package to your app and call <code className="font-mono text-xs">Revflare.configure(sdkKey:server:)</code> at launch. It sends Apple&rsquo;s attribution
                  token once per install; Revflare asks Apple which campaign, ad group and keyword brought it and joins the install&rsquo;s revenue to them.
                </p>
                <p className="mt-2">Each app&rsquo;s SDK key and a Swift snippet are on its page under Apps.</p>
              </>
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
            <Card className="p-5">{d ? <Stat label="Attributed revenue" value={money(totals.revenue, d.currency)} sub={`${money(totals.proceeds, d.currency)} proceeds`} /> : <Skeleton className="h-16" />}</Card>
            <Card className="p-5">
              {d ? <Stat label="Apple Ads installs" value={fullNumber(totals.installs)} sub={`${fullNumber(totals.payers)} payers · ${fullNumber(totals.trials)} trials`} /> : <Skeleton className="h-16" />}
            </Card>
            <Card className="p-5">
              {d ? (
                <Stat
                  label="Revenue per install"
                  value={totals.installs ? money(totals.revenue / totals.installs, d.currency, { cents: true }) : "—"}
                  sub={totals.installs ? `${percent(totals.payers / totals.installs)} of installs paid` : "No attributed installs"}
                />
              ) : (
                <Skeleton className="h-16" />
              )}
            </Card>
            <Card className="p-5">
              {coverage ? (
                <Stat
                  label="Coverage"
                  value={share === null ? "—" : percent(share)}
                  sub={`${fullNumber(coverage.attributed)} of ${fullNumber(coverage.installs)} reporting installs came from Apple Ads${
                    coverage.testInstalls ? ` (${fullNumber(coverage.testInstalls)} test ${coverage.testInstalls === 1 ? "install" : "installs"} ${d?.includeTest ? "included" : "hidden"})` : ""
                  }`}
                />
              ) : (
                <Skeleton className="h-16" />
              )}
            </Card>
          </div>

          <Card className="mt-5">
            <CardHeader title="Attributed revenue" description={`Per ${chart?.interval ?? "day"}, by campaign (top ${TOP_CAMPAIGNS}). Revenue counts on the purchase day.`} />
            <div className="px-3 pb-5 sm:px-5">
              {!d ? (
                <ChartSkeleton height={260} />
              ) : !chart ? (
                <p className="px-2 py-16 text-center text-sm text-zinc-500">No Apple Ads installs in this range.</p>
              ) : (
                <>
                  <Legend className="mb-3 px-2" items={chart.series.map((s) => ({ key: s.key, label: s.label, color: s.color }))} />
                  <TimeChart
                    dates={chart.dates}
                    interval={chart.interval}
                    series={chart.series}
                    height={260}
                    showTotal
                    formatValue={(v) => money(v, d.currency)}
                    formatAxis={(v) => formatAxis(v, "money", d.currency)}
                    label="Revenue attributed to Apple Ads, stacked by campaign"
                  />
                </>
              )}
            </div>
          </Card>

          <Card className="mt-5 overflow-hidden">
            <CardHeader
              title="Campaigns"
              description="Click a campaign for its ad groups and keywords. Names come from Adsflare (when connected) or the Names dialog; ids without a name show as #id."
              action={
                tree.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => (allOpen ? setOpen(new Set()) : expandAll())}>
                    {allOpen ? "Collapse all" : "Expand all"}
                  </Button>
                )
              }
            />
            {!d ? (
              <div className="space-y-2 px-5 pb-5">
                {Array.from({ length: 5 }, (_, i) => (
                  <Skeleton key={i} className="h-10" />
                ))}
              </div>
            ) : tree.length === 0 ? (
              <p className="px-5 pb-8 text-center text-sm text-zinc-500">No Apple Ads installs in this range.</p>
            ) : (
              <Table>
                <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
                  <tr>
                    <th className={th}>Campaign · ad group · keyword</th>
                    <th className={cn(th, "text-right")}>Revenue</th>
                    <th className={cn(th, "text-right")}>Proceeds</th>
                    <th className={cn(th, "text-right")}>Transactions</th>
                    <th className={cn(th, "text-right")}>Trials</th>
                    <th className={cn(th, "text-right")}>Installs</th>
                    <th className={cn(th, "text-right")}>Payers</th>
                    <th className={cn(th, "text-right")}>Revenue / install</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {tree.map((c) => (
                    <Fragment key={c.key}>
                      <TreeRow n={c} level={0} open={open.has(c.key)} onToggle={() => toggle(c.key)} currency={d.currency} appIcons={[...c.appIds].map((id) => byId.get(id))} />
                      {open.has(c.key) &&
                        sortNodes(c.children).map((g) => (
                          <Fragment key={g.key}>
                            <TreeRow n={g} level={1} open={open.has(g.key)} onToggle={() => toggle(g.key)} currency={d.currency} />
                            {open.has(g.key) && sortNodes(g.children).map((k) => <TreeRow key={k.key} n={k} level={2} currency={d.currency} />)}
                          </Fragment>
                        ))}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot className="border-t border-zinc-200 bg-zinc-50/60 font-semibold dark:border-zinc-700 dark:bg-zinc-800/30">
                  <tr>
                    <td className={td}>Total</td>
                    <Cells t={totals} currency={d.currency} />
                  </tr>
                </tfoot>
              </Table>
            )}
          </Card>
        </>
      )}
    </>
  );
}

const LEVELS = [
  { name: "Campaign", none: "Unknown campaign" },
  { name: "Ad group", none: "No ad group" },
  { name: "Keyword", none: "No keyword (search match or other)" },
];

function TreeRow({
  n,
  level,
  open,
  onToggle,
  currency,
  appIcons,
}: {
  n: Node;
  level: number;
  open?: boolean;
  onToggle?: () => void;
  currency: string;
  appIcons?: Array<{ name: string; iconUrl: string | null } | undefined>;
}) {
  const L = LEVELS[level];
  return (
    <tr
      className={cn(onToggle && "cursor-pointer hover:bg-zinc-50 dark:hover:bg-zinc-800/40", level === 2 && "bg-zinc-50/40 dark:bg-zinc-900/40")}
      onClick={onToggle}
      onKeyDown={(e) => onToggle && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onToggle())}
      tabIndex={onToggle ? 0 : undefined}
      aria-expanded={onToggle ? !!open : undefined}
    >
      <td className={td}>
        <div className="flex items-center gap-2" style={{ paddingLeft: level * 22 }}>
          {onToggle ? <ChevronRight className={cn("size-4 shrink-0 text-zinc-400 transition-transform", open && "rotate-90")} /> : <span className="size-4 shrink-0" />}
          {appIcons?.map((a, i) => a && <AppIcon key={i} name={a.name} url={a.iconUrl} size={22} />)}
          <span className={cn(level === 0 ? "font-medium" : "text-zinc-700 dark:text-zinc-300", !n.id && "text-zinc-500 italic dark:text-zinc-400")} title={n.id ? `${L.name} ${n.id}` : undefined}>
            {n.id ? (
              <>
                <span className="text-zinc-500 dark:text-zinc-400">{L.name} </span>
                {n.name ? n.name : <span className="font-mono text-[13px]">{label(n)}</span>}
              </>
            ) : (
              L.none
            )}
          </span>
          {level === 0 && n.test && (
            <Badge tone="amber" title="Apple's AdServices test payload, a sandbox / Xcode build or a test device">
              Test (sandbox) attribution
            </Badge>
          )}
          {onToggle && n.children.size > 0 && (
            <span className="text-xs text-zinc-400">
              {n.children.size} {level === 0 ? (n.children.size === 1 ? "ad group" : "ad groups") : n.children.size === 1 ? "keyword" : "keywords"}
            </span>
          )}
        </div>
      </td>
      <Cells t={n} currency={currency} />
    </tr>
  );
}

function Cells({ t, currency }: { t: Totals; currency: string }) {
  const num = cn(td, "text-right tabular-nums");
  return (
    <>
      <td className={cn(num, "font-medium")}>{money(t.revenue, currency)}</td>
      <td className={cn(num, "text-zinc-600 dark:text-zinc-300")}>{money(t.proceeds, currency)}</td>
      <td className={num}>{fullNumber(t.transactions)}</td>
      <td className={num}>{fullNumber(t.trials)}</td>
      <td className={num}>{fullNumber(t.installs)}</td>
      <td className={num}>{fullNumber(t.payers)}</td>
      <td className={num}>{t.installs ? money(t.revenue / t.installs, currency, { cents: true }) : "—"}</td>
    </>
  );
}
