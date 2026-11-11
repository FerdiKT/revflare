import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowDown, ArrowLeft, ArrowUp, Copy, LayoutTemplate, MapPin, Pencil, Plus, Star, Trash2, TriangleAlert } from "lucide-react";
import { OFFERING_IDENTIFIER_RE, OFFERING_LIMITS, PACKAGE_PRESETS, type Offering, type OfferingInput, type OfferingsChange, type OfferingsConfig, type Product } from "@shared/types";
import { AppIcon } from "../components/Logo";
import { Button, IconButton } from "../components/ui/Button";
import { useConfirm } from "../components/ui/Confirm";
import { Dialog } from "../components/ui/Dialog";
import { Field, Input, Select, Textarea } from "../components/ui/Form";
import { Badge, Card, CardHeader, CopyButton, EmptyState, ErrorState, Skeleton, Table, td, th } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { cn } from "../lib/format";
import { useSession } from "../lib/session";
import { useFetch } from "../lib/useFetch";
import { EntitlementsCard } from "./EntitlementsCard";

const validId = (s: string) => OFFERING_IDENTIFIER_RE.test(s) && !/^\.+$/.test(s);
const PRESET_LABELS: Record<string, string> = {
  $weekly: "Weekly",
  $monthly: "Monthly",
  $two_month: "Two months",
  $three_month: "Three months",
  $six_month: "Six months",
  $annual: "Annual",
  $lifetime: "Lifetime",
};

/** Parses a metadata textarea: "" → {}, otherwise a JSON object of at most 8 KB. */
function parseMetadata(text: string): { value: Record<string, unknown> } | { error: string } {
  if (!text.trim()) return { value: {} };
  try {
    const v = JSON.parse(text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "Must be a JSON object { ... }" };
    if (new TextEncoder().encode(JSON.stringify(v)).length > OFFERING_LIMITS.metadataBytes) return { error: "Larger than 8 KB" };
    return { value: v as Record<string, unknown> };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

const pretty = (v: Record<string, unknown>) => (Object.keys(v).length ? JSON.stringify(v, null, 2) : "");

/** Apps → app → Offerings: offerings (packages → App Store products), the current one, placements and the SDK JSON. */
export function OfferingsPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const manage = can("manage");
  const app = useFetch(`app:${id}`, () => api.apps.get(id), { tags: ["apps"] });
  const r = useFetch(`offerings:${id}`, () => api.apps.offerings.get(id), { tags: ["apps"] });
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ mode: "create" | "edit"; offering: OfferingInput & { original?: string } } | null>(null);
  const products = app.data?.products ?? [];
  const known = useMemo(() => new Set(products.map((p) => p.productId)), [products]);
  const cfg = r.data;

  /** Runs a change; the response is the new config (warnings shown as a toast). */
  const run = async (name: string, fn: () => Promise<OfferingsChange>, ok: string) => {
    setBusy(name);
    try {
      const res = await fn();
      r.setData(() => res);
      if (res.warnings.length) toast.info(ok, res.warnings.join(" "));
      else toast.success(ok);
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

  const remove = async (o: Offering) => {
    const users = cfg.placements.filter((p) => p.offeringId === o.identifier).map((p) => p.identifier);
    const ok = await confirm({
      title: `Delete ${o.identifier}?`,
      message: users.length
        ? `Placements ${users.join(", ")} use it: they will show the current offering instead.`
        : o.isCurrent
          ? "It is the current offering: the app then has no current offering until you pick another one."
          : "Apps stop getting it within a minute.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) await run(`delete:${o.identifier}`, () => api.apps.offerings.remove(id, o.identifier, users.length > 0), "Offering deleted");
  };

  const duplicate = (o: Offering) => {
    let n = 2;
    const base = o.identifier.slice(0, 58);
    let copy = `${base}_copy`;
    while (cfg.offerings.some((x) => x.identifier === copy)) copy = `${base}_copy${n++}`;
    setEditing({ mode: "create", offering: { identifier: copy, displayName: `${o.displayName} (copy)`, metadata: o.metadata, packages: o.packages } });
  };

  return (
    <>
      {back}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        {app.data && <AppIcon name={app.data.name} url={app.data.iconUrl} size={48} />}
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Offerings</h1>
          <p className="mt-0.5 text-sm text-zinc-500">
            The products each paywall shows, changed without an app update. RevflareKit loads them at launch (apps pick up changes within a minute) — see{" "}
            <a href="https://github.com/FerdiKT/revflare/blob/main/sdk/ios/README.md" target="_blank" rel="noreferrer" className="text-brand-700 hover:underline dark:text-brand-400">
              the SDK guide
            </a>
            .
          </p>
        </div>
        {manage && (
          <Button variant="primary" icon={<Plus className="size-4" />} disabled={cfg.offerings.length >= OFFERING_LIMITS.offerings} onClick={() => setEditing({ mode: "create", offering: { identifier: cfg.offerings.length ? "" : "default", displayName: "", metadata: {}, packages: [] } })}>
            New offering
          </Button>
        )}
      </div>

      <Card className="overflow-hidden">
        <CardHeader title="Offerings" description={`One offering is current: the default paywall and every placement without its own offering. Up to ${OFFERING_LIMITS.offerings} per app.`} />
        {cfg.offerings.length === 0 ? (
          <EmptyState icon={<LayoutTemplate />} title="No offerings yet" description="Create one with the products of your paywall (e.g. $annual and $monthly). The first offering becomes current." />
        ) : (
          <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
            {cfg.offerings.map((o) => (
              <li key={o.identifier} className="flex flex-wrap items-start gap-3 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-mono text-sm font-medium">{o.identifier}</p>
                    {o.displayName !== o.identifier && <p className="text-sm text-zinc-500">{o.displayName}</p>}
                    {o.isCurrent && (
                      <Badge tone="green" dot>
                        Current
                      </Badge>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {o.packages.length === 0 && <span className="text-xs text-zinc-500">No packages</span>}
                    {o.packages.map((p) => (
                      <span key={p.identifier} className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-2 py-0.5 text-xs dark:bg-zinc-800" title={known.has(p.productId) ? undefined : "Not one of the app's known products"}>
                        <span className="font-medium">{p.identifier}</span>
                        <span className="font-mono text-zinc-500">{p.productId}</span>
                        {products.length > 0 && !known.has(p.productId) && <TriangleAlert className="size-3 text-amber-500" />}
                      </span>
                    ))}
                  </div>
                </div>
                {manage && (
                  <div className="flex items-center gap-1">
                    {!o.isCurrent && (
                      <Button size="sm" variant="ghost" icon={<Star className="size-3.5" />} loading={busy === `current:${o.identifier}`} onClick={() => run(`current:${o.identifier}`, () => api.apps.offerings.makeCurrent(id, o.identifier), `${o.identifier} is now current`)}>
                        Make current
                      </Button>
                    )}
                    <IconButton label="Edit" size="sm" onClick={() => setEditing({ mode: "edit", offering: { ...o, original: o.identifier } })}>
                      <Pencil className="size-4" />
                    </IconButton>
                    <IconButton label="Duplicate" size="sm" onClick={() => duplicate(o)} disabled={cfg.offerings.length >= OFFERING_LIMITS.offerings}>
                      <Copy className="size-4" />
                    </IconButton>
                    <IconButton label="Delete" size="sm" variant="danger" onClick={() => remove(o)} disabled={busy === `delete:${o.identifier}`}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="mt-5">
        <EntitlementsCard appId={id} platform={app.data?.platform} manage={manage} products={products} onChanged={r.refetch} />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <Placements cfg={cfg} manage={manage} busy={busy} run={run} appId={id} />
        <Card className="overflow-hidden">
          <CardHeader
            title="What the SDK gets"
            description={`GET /sdk/v1/offerings · version ${cfg.version}`}
            action={<CopyButton text={JSON.stringify(cfg.preview, null, 2)} />}
          />
          <pre className="max-h-[28rem] overflow-auto border-t border-zinc-100 bg-zinc-50 px-5 py-4 font-mono text-xs leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300">
            {JSON.stringify(cfg.preview, null, 2)}
          </pre>
        </Card>
      </div>

      {editing && (
        <OfferingEditor
          key={`${editing.mode}:${editing.offering.original ?? editing.offering.identifier}`}
          mode={editing.mode}
          initial={editing.offering}
          products={products}
          taken={cfg.offerings.map((o) => o.identifier).filter((x) => x !== editing.offering.original)}
          busy={busy === "save"}
          onClose={() => setEditing(null)}
          onSave={async (o) => {
            const res =
              editing.mode === "create"
                ? await run("save", () => api.apps.offerings.create(id, o), `Offering ${o.identifier} created`)
                : await run("save", () => api.apps.offerings.update(id, editing.offering.original!, o), `Offering ${o.identifier} saved`);
            if (res) setEditing(null);
          }}
        />
      )}
    </>
  );
}

function Placements({ cfg, manage, busy, run, appId }: { cfg: OfferingsConfig; manage: boolean; busy: string | null; run: (name: string, fn: () => Promise<OfferingsChange>, ok: string) => Promise<OfferingsChange | null>; appId: string }) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const options = (
    <>
      <option value="">Current offering{cfg.currentOfferingId ? ` (${cfg.currentOfferingId})` : " (none)"}</option>
      {cfg.offerings.map((o) => (
        <option key={o.identifier} value={o.identifier}>
          {o.identifier}
        </option>
      ))}
    </>
  );
  const nameBad = name !== "" && (!validId(name) || cfg.placements.some((p) => p.identifier === name));
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Placements" description="Paywall locations in the app (onboarding, settings, ...): each shows its own offering or the current one." />
      {cfg.placements.length === 0 ? (
        <p className="flex items-center gap-2 border-t border-zinc-100 px-5 py-4 text-sm text-zinc-500 dark:border-zinc-800">
          <MapPin className="size-4 text-zinc-400" /> No placements: every paywall shows the current offering.
        </p>
      ) : (
        <Table>
          <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
            <tr>
              <th className={th}>Placement</th>
              <th className={th}>Offering</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {cfg.placements.map((p) => (
              <tr key={p.identifier}>
                <td className={cn(td, "font-mono text-xs")}>{p.identifier}</td>
                <td className={cn(td, "w-1/2")}>
                  <Select
                    aria-label={`Offering of ${p.identifier}`}
                    value={p.offeringId ?? ""}
                    disabled={!manage || busy === `placement:${p.identifier}`}
                    onChange={(e) => run(`placement:${p.identifier}`, () => api.apps.offerings.setPlacement(appId, p.identifier, e.target.value || null), `${p.identifier} updated`)}
                  >
                    {options}
                  </Select>
                </td>
                <td className={cn(td, "w-10 text-right")}>
                  {manage && (
                    <IconButton label="Remove" size="sm" variant="danger" onClick={() => run(`placement:${p.identifier}`, () => api.apps.offerings.removePlacement(appId, p.identifier), `${p.identifier} removed`)}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {manage && cfg.placements.length < OFFERING_LIMITS.placements && (
        <form
          className="flex flex-wrap items-start gap-2 border-t border-zinc-100 px-5 py-4 dark:border-zinc-800"
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run("placement:new", () => api.apps.offerings.setPlacement(appId, name, target || null), `Placement ${name} added`)) setName("");
          }}
        >
          <Input aria-label="Placement identifier" className="w-44 font-mono text-xs" placeholder="onboarding" value={name} invalid={nameBad} onChange={(e) => setName(e.target.value.trim())} />
          <Select aria-label="Offering" className="min-w-40 flex-1" value={target} onChange={(e) => setTarget(e.target.value)}>
            {options}
          </Select>
          <Button type="submit" icon={<Plus className="size-4" />} loading={busy === "placement:new"} disabled={!name || nameBad}>
            Add
          </Button>
        </form>
      )}
    </Card>
  );
}

interface PackageDraft {
  key: number;
  identifier: string;
  custom: boolean;
  productId: string;
  metadata: string;
}

let nextKey = 1;

function OfferingEditor({
  mode,
  initial,
  products,
  taken,
  busy,
  onClose,
  onSave,
}: {
  mode: "create" | "edit";
  initial: OfferingInput;
  products: Product[];
  taken: string[];
  busy: boolean;
  onClose: () => void;
  onSave: (o: OfferingInput) => void;
}) {
  const [identifier, setIdentifier] = useState(initial.identifier);
  const [displayName, setDisplayName] = useState(initial.displayName ?? "");
  const [metadata, setMetadata] = useState(pretty(initial.metadata ?? {}));
  const [packages, setPackages] = useState<PackageDraft[]>(() =>
    (initial.packages ?? []).map((p) => ({ key: nextKey++, identifier: p.identifier, custom: !(PACKAGE_PRESETS as readonly string[]).includes(p.identifier), productId: p.productId, metadata: pretty(p.metadata ?? {}) })),
  );
  const meta = parseMetadata(metadata);
  const idError = !identifier ? "Required" : !validId(identifier) ? "Letters, digits, _ . $ - (at most 64)" : taken.includes(identifier) ? "Already used" : null;
  const pkgErrors = packages.map((p, i) => {
    if (!validId(p.identifier)) return "Package identifier: letters, digits, _ . $ - (at most 64)";
    if (packages.findIndex((x) => x.identifier === p.identifier) !== i) return "Package identifier used twice";
    if (!/^[\x21-\x7e]{1,255}$/.test(p.productId.trim())) return "Pick a product";
    const m = parseMetadata(p.metadata);
    return "error" in m ? `Metadata: ${m.error}` : null;
  });
  const invalid = !!idError || "error" in meta || pkgErrors.some(Boolean);
  const set = (key: number, patch: Partial<PackageDraft>) => setPackages((ps) => ps.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  const move = (i: number, d: -1 | 1) =>
    setPackages((ps) => {
      const next = [...ps];
      [next[i], next[i + d]] = [next[i + d], next[i]];
      return next;
    });
  const unused = PACKAGE_PRESETS.find((p) => !packages.some((x) => x.identifier === p));

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={mode === "create" ? "New offering" : `Edit ${initial.identifier}`}
      description="Packages are shown in this order. Metadata is free-form JSON your paywall reads (titles, colors, feature lists...)."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={invalid}
            onClick={() =>
              onSave({
                identifier,
                displayName: displayName.trim() || identifier,
                metadata: "value" in meta ? meta.value : {},
                packages: packages.map((p) => ({ identifier: p.identifier, productId: p.productId.trim(), metadata: (parseMetadata(p.metadata) as { value: Record<string, unknown> }).value })),
              })
            }
          >
            {mode === "create" ? "Create" : "Save"}
          </Button>
        </>
      }
    >
      <div className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Identifier" required error={identifier && idError} help={mode === "edit" ? "Renaming updates the placements that use it." : "Used by the app and placements, e.g. default, black_friday."}>
            {(fid) => <Input id={fid} data-autofocus className="font-mono text-xs" placeholder="default" value={identifier} invalid={!!identifier && !!idError} onChange={(e) => setIdentifier(e.target.value.trim())} />}
          </Field>
          <Field label="Display name" help="Optional, for you and the paywall.">
            {(fid) => <Input id={fid} maxLength={100} placeholder={identifier || "Default"} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}
          </Field>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">Packages</p>
            <Button
              size="sm"
              icon={<Plus className="size-3.5" />}
              disabled={packages.length >= OFFERING_LIMITS.packages}
              onClick={() => setPackages((ps) => [...ps, { key: nextKey++, identifier: unused ?? "", custom: !unused, productId: "", metadata: "" }])}
            >
              Add package
            </Button>
          </div>
          {packages.length === 0 ? (
            <p className="rounded-xl px-4 py-3 text-sm text-zinc-500 ring-1 ring-zinc-200 dark:ring-zinc-700">No packages yet.</p>
          ) : (
            <div className="divide-y divide-zinc-100 rounded-xl ring-1 ring-zinc-200 dark:divide-zinc-800 dark:ring-zinc-700">
              {packages.map((p, i) => (
                <PackageRow
                  key={p.key}
                  p={p}
                  products={products}
                  error={pkgErrors[i]}
                  first={i === 0}
                  last={i === packages.length - 1}
                  onChange={(patch) => set(p.key, patch)}
                  onMove={(d) => move(i, d)}
                  onRemove={() => setPackages((ps) => ps.filter((x) => x.key !== p.key))}
                />
              ))}
            </div>
          )}
        </div>

        <Field label="Metadata (JSON)" error={"error" in meta ? meta.error : undefined} help="Optional JSON object, at most 8 KB.">
          {(fid) => <Textarea id={fid} rows={5} spellCheck={false} className="font-mono text-xs" placeholder={'{\n  "title": "Unlock everything"\n}'} value={metadata} invalid={"error" in meta} onChange={(e) => setMetadata(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

function PackageRow({
  p,
  products,
  error,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  p: PackageDraft;
  products: Product[];
  error: string | null;
  first: boolean;
  last: boolean;
  onChange: (patch: Partial<PackageDraft>) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
}) {
  const [showMeta, setShowMeta] = useState(p.metadata !== "");
  const knownProduct = products.some((x) => x.productId === p.productId);
  const [otherProduct, setOtherProduct] = useState(p.productId !== "" && !knownProduct);
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          aria-label="Package identifier"
          className="w-40"
          value={p.custom ? "__custom" : p.identifier}
          onChange={(e) => (e.target.value === "__custom" ? onChange({ custom: true }) : onChange({ custom: false, identifier: e.target.value }))}
        >
          {PACKAGE_PRESETS.map((x) => (
            <option key={x} value={x}>
              {x} · {PRESET_LABELS[x]}
            </option>
          ))}
          <option value="__custom">Custom…</option>
        </Select>
        {p.custom && <Input aria-label="Custom package identifier" className="w-36 font-mono text-xs" placeholder="$custom" value={p.identifier} onChange={(e) => onChange({ identifier: e.target.value.trim() })} />}
        <div className="min-w-48 flex-1">
          {otherProduct || products.length === 0 ? (
            <Input aria-label="App Store product id" className="font-mono text-xs" placeholder="com.example.app.annual" value={p.productId} onChange={(e) => onChange({ productId: e.target.value })} />
          ) : (
            <Select
              aria-label="Product"
              value={knownProduct ? p.productId : ""}
              onChange={(e) => (e.target.value === "__other" ? (setOtherProduct(true), onChange({ productId: "" })) : onChange({ productId: e.target.value }))}
            >
              <option value="" disabled>
                Pick a product…
              </option>
              {products.map((x) => (
                <option key={x.productId} value={x.productId}>
                  {x.name ? `${x.name} · ${x.productId}` : x.productId}
                </option>
              ))}
              <option value="__other">Other product id…</option>
            </Select>
          )}
        </div>
        <div className="flex items-center">
          <IconButton label="Move up" size="sm" disabled={first} onClick={() => onMove(-1)}>
            <ArrowUp className="size-4" />
          </IconButton>
          <IconButton label="Move down" size="sm" disabled={last} onClick={() => onMove(1)}>
            <ArrowDown className="size-4" />
          </IconButton>
          <IconButton label="Remove package" size="sm" variant="danger" onClick={onRemove}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <button type="button" className="text-brand-700 hover:underline dark:text-brand-400" onClick={() => setShowMeta(!showMeta)}>
          {showMeta ? "Hide metadata" : "Package metadata"}
        </button>
        {products.length > 0 && (
          <button type="button" className="text-zinc-500 hover:underline" onClick={() => setOtherProduct(!otherProduct)}>
            {otherProduct ? "Pick from the app's products" : "Type a product id"}
          </button>
        )}
        {p.productId && products.length > 0 && !knownProduct && <span className="text-amber-600 dark:text-amber-400">Not one of the app&rsquo;s known products</span>}
        {error && <span className="text-red-600 dark:text-red-400">{error}</span>}
      </div>
      {showMeta && <Textarea aria-label="Package metadata (JSON)" rows={3} spellCheck={false} className="font-mono text-xs" placeholder={'{ "badge": "Best value" }'} value={p.metadata} invalid={"error" in parseMetadata(p.metadata)} onChange={(e) => onChange({ metadata: e.target.value })} />}
    </div>
  );
}

