import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { KEY_EVENT_PATTERN_RE } from "@shared/types";
import { Button } from "../components/ui/Button";
import { Field, Input } from "../components/ui/Form";
import { Badge, Card, CardHeader, ErrorState, PageHeader, Skeleton } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { fullNumber } from "../lib/format";
import { useSession } from "../lib/session";
import { useFetch } from "../lib/useFetch";
import { BackToApp } from "./EventsPage";

/** Apps → app → Key events: events stored exactly in the database besides Analytics Engine (docs/funnels.md#exact-key-events). */
export function KeyEventsPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const manage = can("manage");
  const toast = useToast();
  const app = useFetch(`app:${id}`, () => api.apps.get(id), { tags: ["apps"] });
  const r = useFetch(`key-events:${id}`, () => api.apps.keyEvents.get(id));
  const [patterns, setPatterns] = useState("");
  const [cap, setCap] = useState("");
  const [retention, setRetention] = useState("");
  const [busy, setBusy] = useState(false);
  const s = r.data;

  useEffect(() => {
    if (!s) return;
    setPatterns(s.patterns.join("\n"));
    setCap(s.dailyCapIsDefault ? "" : String(s.dailyCap));
    setRetention(String(s.retentionDays));
  }, [s]);

  const list = patterns
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const badPattern = list.find((p) => !KEY_EVENT_PATTERN_RE.test(p));
  const patternError = badPattern
    ? `"${badPattern}" is not an event name or pattern (one * at the start or the end)`
    : s && list.length > s.limits.patterns
      ? `At most ${s.limits.patterns} patterns`
      : null;
  // Empty: the instance's default.
  const capN = cap === "" ? null : Number(cap);
  const capError = s && cap !== "" && (!/^\d+$/.test(cap) || Number(cap) > s.limits.maxDailyCap) ? `Empty (default) or a whole number from 0 to ${fullNumber(s.limits.maxDailyCap)}` : null;
  const effectiveCap = s ? (capN ?? s.defaultDailyCap) : 0;
  const capWrites = s ? effectiveCap * s.writesPerEvent : 0;
  const capWarning = !!s && !capError && capWrites > s.backgroundWritesPerDay / 2;
  const retN = Number(retention);
  const retError = s && (!/^\d+$/.test(retention) || retN < s.limits.minRetentionDays || retN > s.limits.maxRetentionDays) ? `${s.limits.minRetentionDays} to ${s.limits.maxRetentionDays} days` : null;
  const capDirty = !!s && (capN === null ? !s.dailyCapIsDefault : s.dailyCapIsDefault || capN !== s.dailyCap);
  const dirty = !!s && (list.join("\n") !== s.patterns.join("\n") || capDirty || retN !== s.retentionDays);

  const save = async () => {
    setBusy(true);
    try {
      const res = await api.apps.keyEvents.update(id, { patterns: list, dailyCap: capN, retentionDays: retN });
      r.setData(() => res);
      toast.success("Key events saved");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <BackToApp id={id} name={app.data?.name} />
      <PageHeader
        title="Key events"
        description="Analytics Engine samples the events of apps that send a lot. Key events are also stored exactly in the database, so funnels, experiment exposures, alerts and the Events page count every install once the stored data covers their range."
      />
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} />}
      {!s && !r.error && <Skeleton className="h-64" />}
      {s && (
        <Card>
          <CardHeader
            title="Stored exactly"
            description="Each install stores at most 500 key events a day. Over the daily cap, the rest of the day stays in Analytics Engine only (sampled) and an alert is raised."
          />
          <div className="space-y-5 border-t border-zinc-100 px-5 py-4 dark:border-zinc-800">
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <span className="text-zinc-500">Exact since </span>
                <span className="font-medium">{s.since ?? "not yet"}</span>
              </div>
              <div>
                <span className="text-zinc-500">Daily cap in effect </span>
                <span className="font-medium tabular-nums">{fullNumber(s.dailyCap)}</span>
                {s.dailyCapIsDefault && <span className="text-zinc-500"> (default)</span>}
              </div>
              <div>
                <span className="text-zinc-500">Today ({s.today.date}) </span>
                <span className="font-medium tabular-nums">{fullNumber(s.today.count)}</span>
                <span className="text-zinc-500"> stored</span>
                {s.today.capped && (
                  <Badge tone="amber" className="ml-2">
                    incomplete: rest of the day sampled
                  </Badge>
                )}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-sm font-medium text-zinc-800 dark:text-zinc-200">Built in</p>
              <div className="flex flex-wrap gap-1.5">
                {s.builtin.map((b) => (
                  <Badge key={b} className="font-mono">
                    {b}
                  </Badge>
                ))}
              </div>
            </div>
            <Field
              label="Extra patterns"
              help={`One per line, up to ${s.limits.patterns}: an event name, or one * at the start or the end (*_paywall_view, promo_*). Case-insensitive; exact from the next UTC day.`}
              error={patternError}
            >
              {(fid) => (
                <textarea
                  id={fid}
                  rows={4}
                  disabled={!manage}
                  className="block w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
                  placeholder="*_paywall_view"
                  value={patterns}
                  onChange={(e) => setPatterns(e.target.value)}
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Daily cap"
                help={`Key events stored per UTC day at most (0 stores none). Empty: this instance's default, ${fullNumber(s.defaultDailyCap)} (at most half its daily background write budget).`}
                error={capError}
              >
                {(fid) => (
                  <Input
                    id={fid}
                    inputMode="numeric"
                    disabled={!manage}
                    value={cap}
                    placeholder={`${fullNumber(s.defaultDailyCap)} (default)`}
                    invalid={!!capError}
                    onChange={(e) => setCap(e.target.value.trim())}
                  />
                )}
              </Field>
              <Field label="Retention (days)" help="Stored key events are deleted after this many days." error={retError}>
                {(fid) => <Input id={fid} inputMode="numeric" disabled={!manage} value={retention} invalid={!!retError} onChange={(e) => setRetention(e.target.value.trim())} />}
              </Field>
            </div>
            {capWarning && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                A full day at {fullNumber(effectiveCap)} key events writes about {fullNumber(capWrites)} database rows ({s.writesPerEvent} per event): more than
                half of this instance's daily background budget ({fullNumber(s.backgroundWritesPerDay)} rows). Once the budget is used up, imports and syncs
                wait until 00:00 UTC and the rest of the day's key events are sampled. Raise BACKGROUND_WRITES_PER_DAY on Workers Paid.
              </p>
            )}
            {manage && (
              <div className="flex justify-end">
                <Button loading={busy} disabled={!dirty || !!patternError || !!capError || !!retError} onClick={save}>
                  Save
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}
    </>
  );
}
