import { useMemo, useState } from "react";
import { KeyRound, Plus, Timer, Trash2, TriangleAlert, X } from "lucide-react";
import { DURATION_UNITS, ENTITLEMENT_LIMITS, OFFERING_IDENTIFIER_RE, type DurationUnit, type EntitlementsChange, type Product } from "@shared/types";
import { Button, IconButton } from "../components/ui/Button";
import { useConfirm } from "../components/ui/Confirm";
import { Input, Select } from "../components/ui/Form";
import { Card, CardHeader, EmptyState, ErrorState, Skeleton } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { useFetch } from "../lib/useFetch";

const validId = (s: string) => OFFERING_IDENTIFIER_RE.test(s) && !/^\.+$/.test(s);
const validProduct = (s: string) => /^[\x21-\x7e]{1,255}$/.test(s);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Apps → app → Offerings → Entitlements: server-driven entitlement → product ids (merged by RevflareKit 1.9+ with the
 * app's own map) and the durations of non-renewing products (passes). Changes reach apps with the offerings payload.
 */
export function EntitlementsCard({
  appId,
  platform,
  manage,
  products,
  onChanged,
}: {
  appId: string;
  platform?: string;
  manage: boolean;
  products: Product[];
  onChanged: () => void;
}) {
  const r = useFetch(`entitlements:${appId}`, () => api.apps.entitlements.get(appId), { tags: ["apps"] });
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState<Record<string, string>>({});
  const [durProduct, setDurProduct] = useState("");
  const [durCount, setDurCount] = useState("3");
  const [durUnit, setDurUnit] = useState<DurationUnit>("day");
  const known = useMemo(() => new Set(products.map((p) => p.productId)), [products]);
  const android = platform === "android";
  // Products that can take a duration: iOS non-renewing subscriptions; Google Play one-time products (Play does not say
  // whether one is a lifetime product, hence the warning below). Never non-consumables or subscriptions (the server
  // refuses them too).
  const passCandidates = products.filter((p) => (android ? p.type !== "auto_renewable" && p.type !== "non_consumable" : p.type === "non_renewing"));

  const run = async (name: string, fn: () => Promise<EntitlementsChange>, ok: string) => {
    setBusy(name);
    try {
      const res = await fn();
      r.setData(() => res);
      onChanged();
      const extra =
        (res.updatedTransactions ? ` Expiry recomputed on ${plural(res.updatedTransactions, "stored transaction")}.` : "") +
        (res.truncated ? " The other stored transactions are recomputed in the background." : "");
      if (res.warnings.length) toast.info(ok, res.warnings.join(" ") + extra);
      else if (extra) toast.info(ok, extra.trim());
      else toast.success(ok);
      return res;
    } catch (err) {
      toast.error(err);
      return null;
    } finally {
      setBusy(null);
    }
  };

  if (r.error) return <ErrorState error={r.error} onRetry={r.refetch} />;
  const cfg = r.data;
  if (!cfg) return <Skeleton className="h-48" />;

  const nameBad = newName !== "" && (!validId(newName) || cfg.entitlements.some((e) => e.identifier === newName));
  const count = Number(durCount);
  const durBad = !validProduct(durProduct) || !Number.isInteger(count) || count < 1 || count > ENTITLEMENT_LIMITS.maxCount;
  const productList = `entitlement-products-${appId}`;

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="Entitlements"
        description="Which products unlock what, without an app update: RevflareKit 1.9+ adds these to the app's own entitlement map (union) and loads the products listed here. Non-renewing products (passes) need a duration, otherwise they count as lifetime."
      />
      <datalist id={productList}>
        {products.map((p) => (
          <option key={p.productId} value={p.productId}>
            {p.name ?? ""}
          </option>
        ))}
      </datalist>
      {cfg.entitlements.length === 0 ? (
        <EmptyState icon={<KeyRound />} title="No server entitlements" description="The app's own map applies alone. Add e.g. pro with the products that unlock it." />
      ) : (
        <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
          {cfg.entitlements.map((e) => {
            const draft = adding[e.identifier] ?? "";
            return (
              <li key={e.identifier} className="flex flex-wrap items-start gap-3 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm font-medium">{e.identifier}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {e.productIds.length === 0 && <span className="text-xs text-zinc-500">No products</span>}
                    {e.productIds.map((p) => (
                      <span key={p} className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800" title={known.has(p) ? undefined : "Not one of the app's known products"}>
                        <span className="font-mono">{p}</span>
                        {products.length > 0 && !known.has(p) && <TriangleAlert className="size-3 text-amber-500" />}
                        {manage && (
                          <button
                            type="button"
                            aria-label={`Remove ${p}`}
                            className="text-zinc-400 hover:text-red-600"
                            disabled={busy !== null}
                            onClick={() => run(`ent:${e.identifier}`, () => api.apps.entitlements.set(appId, e.identifier, e.productIds.filter((x) => x !== p)), `${p} removed from ${e.identifier}`)}
                          >
                            <X className="size-3" />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                  {manage && (
                    <form
                      className="mt-2 flex flex-wrap gap-2"
                      onSubmit={async (ev) => {
                        ev.preventDefault();
                        const ids = draft.split(/[\s,]+/).filter(Boolean);
                        if (await run(`ent:${e.identifier}`, () => api.apps.entitlements.set(appId, e.identifier, [...e.productIds, ...ids]), `${e.identifier} updated`)) setAdding((a) => ({ ...a, [e.identifier]: "" }));
                      }}
                    >
                      <Input
                        aria-label={`Add products to ${e.identifier}`}
                        list={productList}
                        className="min-w-56 flex-1 font-mono text-xs"
                        placeholder="com.example.app.pass_3day"
                        value={draft}
                        onChange={(ev) => setAdding((a) => ({ ...a, [e.identifier]: ev.target.value }))}
                      />
                      <Button type="submit" size="sm" icon={<Plus className="size-3.5" />} loading={busy === `ent:${e.identifier}`} disabled={!draft.trim() || !draft.split(/[\s,]+/).filter(Boolean).every(validProduct)}>
                        Add product
                      </Button>
                    </form>
                  )}
                </div>
                {manage && (
                  <IconButton
                    label="Delete"
                    size="sm"
                    variant="danger"
                    onClick={async () => {
                      const ok = await confirm({ title: `Delete ${e.identifier}?`, message: "Apps keep their own map for it; the products added here stop unlocking it within a minute.", confirmLabel: "Delete", danger: true });
                      if (ok) await run(`ent:${e.identifier}`, () => api.apps.entitlements.remove(appId, e.identifier), `${e.identifier} deleted`);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </IconButton>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {manage && cfg.entitlements.length < ENTITLEMENT_LIMITS.entitlements && (
        <form
          className="flex flex-wrap items-start gap-2 border-t border-zinc-100 px-5 py-4 dark:border-zinc-800"
          onSubmit={async (ev) => {
            ev.preventDefault();
            if (await run("ent:new", () => api.apps.entitlements.set(appId, newName, []), `Entitlement ${newName} added`)) setNewName("");
          }}
        >
          <Input aria-label="Entitlement identifier" className="w-44 font-mono text-xs" placeholder="pro" value={newName} invalid={nameBad} onChange={(ev) => setNewName(ev.target.value.trim())} />
          <Button type="submit" icon={<Plus className="size-4" />} loading={busy === "ent:new"} disabled={!newName || nameBad}>
            Add entitlement
          </Button>
        </form>
      )}

      <div className="border-t border-zinc-100 px-5 pt-4 pb-2 dark:border-zinc-800">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Timer className="size-4 text-zinc-400" /> Non-renewing durations
        </p>
        <p className="mt-0.5 text-xs text-zinc-500">
          StoreKit and Google Play give passes no expiry. With a duration, RevflareKit expires them (a repeat purchase extends from the later of now and the current expiry) and Revflare stores purchase + duration as their expiry, also for past sales. Passes stay one-time revenue (never MRR).
          {android ? "" : " On iOS only non-renewing subscriptions take a duration (non-consumables are always lifetime)."} Products the app lists in its own code ignore a duration set here unless the app sets one too.
        </p>
        {android && (
          <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            Google Play does not tell lifetime one-time products from passes: only give a duration to a pass. A duration on a lifetime product would end its buyers&apos; access after that time.
          </p>
        )}
      </div>
      {cfg.durations.length > 0 && (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {cfg.durations.map((d) => (
            <li key={d.productId} className="flex items-center gap-3 px-5 py-2.5">
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{d.productId}</span>
              <span className="text-sm">{plural(d.count, d.unit)}</span>
              {manage && (
                <IconButton label="Remove duration" size="sm" variant="danger" disabled={busy !== null} onClick={() => run(`dur:${d.productId}`, () => api.apps.entitlements.removeDuration(appId, d.productId), `${d.productId}: no duration`)}>
                  <Trash2 className="size-4" />
                </IconButton>
              )}
            </li>
          ))}
        </ul>
      )}
      {manage && (
        <form
          className="flex flex-wrap items-start gap-2 px-5 pt-2 pb-4"
          onSubmit={async (ev) => {
            ev.preventDefault();
            if (await run("dur:new", () => api.apps.entitlements.setDuration(appId, durProduct, { unit: durUnit, count }), `${durProduct}: ${plural(count, durUnit)}`)) setDurProduct("");
          }}
        >
          <Select aria-label="Product" className="min-w-56 flex-1 font-mono text-xs" value={passCandidates.some((p) => p.productId === durProduct) ? durProduct : ""} onChange={(ev) => setDurProduct(ev.target.value)}>
            <option value="">Product…</option>
            {passCandidates.map((p) => (
              <option key={p.productId} value={p.productId}>
                {p.productId}
              </option>
            ))}
          </Select>
          <Input aria-label="Product id" className="min-w-48 flex-1 font-mono text-xs" placeholder="or type a product id" value={durProduct} onChange={(ev) => setDurProduct(ev.target.value.trim())} />
          <Input aria-label="Count" type="number" min={1} max={ENTITLEMENT_LIMITS.maxCount} className="w-20" value={durCount} onChange={(ev) => setDurCount(ev.target.value)} />
          <Select aria-label="Unit" className="w-28" value={durUnit} onChange={(ev) => setDurUnit(ev.target.value as DurationUnit)}>
            {DURATION_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}s
              </option>
            ))}
          </Select>
          <Button type="submit" icon={<Plus className="size-4" />} loading={busy === "dur:new"} disabled={durBad}>
            Set duration
          </Button>
        </form>
      )}
    </Card>
  );
}
