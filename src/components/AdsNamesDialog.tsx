import { useMemo, useState } from "react";
import { ADS_NAME_KINDS, ADS_NAMES_LIMIT, type AdsName, type AdsNameKind } from "@shared/types";
import { api } from "../lib/api";
import { cn } from "../lib/format";
import { useFetch } from "../lib/useFetch";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Input, Textarea } from "./ui/Form";
import { Segmented, Spinner, Table, td, th } from "./ui/Misc";
import { useToast } from "./ui/Toast";

const KIND_LABELS: Record<AdsNameKind, string> = { campaign: "Campaign", adgroup: "Ad group", keyword: "Keyword" };

function normalizeKind(raw: string): AdsNameKind | null {
  const k = raw.trim().toLowerCase().replace(/[\s_-]/g, "").replace(/s$/, "");
  return (ADS_NAME_KINDS as readonly string[]).includes(k) ? (k as AdsNameKind) : null;
}

/** One CSV line (quotes allowed) or a TSV line. */
function splitLine(line: string, sep: string): string[] {
  if (sep === "\t") return line.split("\t");
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Pasted names: JSON (a list of { kind, id, name } or { names: [...] }) or CSV / TSV lines `kind,id,name` (a header
 * line is skipped; names may contain the separator when quoted, or anything after the second column in CSV).
 */
export function parseNamesText(text: string): AdsName[] | { error: string } {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("[") || t.startsWith("{")) {
    let j: unknown;
    try {
      j = JSON.parse(t);
    } catch {
      return { error: "Invalid JSON" };
    }
    const list = Array.isArray(j) ? j : (j as { names?: unknown }).names;
    if (!Array.isArray(list)) return { error: "JSON must be a list of { kind, id, name } (or { names: [...] })" };
    const out: AdsName[] = [];
    for (const e of list as Record<string, unknown>[]) {
      const kind = normalizeKind(String(e?.kind ?? ""));
      const id = String(e?.id ?? "").trim();
      if (!kind || !/^\d{1,20}$/.test(id)) return { error: `Invalid entry: ${JSON.stringify(e)}` };
      out.push({ kind, id, name: String(e.name ?? "").trim() });
    }
    return out;
  }
  const out: AdsName[] = [];
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  for (const [i, line] of lines.entries()) {
    const sep = line.includes("\t") ? "\t" : ",";
    const cells = splitLine(line, sep);
    if (i === 0 && cells[0]?.trim().toLowerCase() === "kind") continue;
    const kind = normalizeKind(cells[0] ?? "");
    const id = (cells[1] ?? "").trim();
    if (!kind || !/^\d{1,20}$/.test(id)) return { error: `Line ${i + 1}: expected kind (campaign, adgroup, keyword), id (digits), name` };
    out.push({ kind, id, name: cells.slice(2).join(sep).trim() });
  }
  return out;
}

/** Apple Ads names: list / edit, and import from pasted CSV, TSV or JSON. */
export function AdsNamesDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const list = useFetch(open ? "ads-names" : null, () => api.adsNames.list());
  const [tab, setTab] = useState<"list" | "import">("list");
  const [filter, setFilter] = useState("");
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseNamesText(text), [text]);

  const names = list.data?.names ?? [];
  const q = filter.trim().toLowerCase();
  const shown = q ? names.filter((n) => n.name.toLowerCase().includes(q) || n.id.includes(q)) : names;
  const key = (n: AdsName) => `${n.kind}:${n.id}`;
  const changed = names.filter((n) => edits[key(n)] !== undefined && edits[key(n)].trim() !== n.name).map((n) => ({ ...n, name: edits[key(n)].trim() }));

  const save = async (items: AdsName[]) => {
    setBusy(true);
    try {
      let updated = 0;
      let deleted = 0;
      for (let i = 0; i < items.length; i += ADS_NAMES_LIMIT) {
        const r = await api.adsNames.put(items.slice(i, i + ADS_NAMES_LIMIT));
        updated += r.updated;
        deleted += r.deleted;
      }
      toast.success(`${updated} ${updated === 1 ? "name" : "names"} saved${deleted ? `, ${deleted} removed` : ""}`);
      setEdits({});
      setText("");
      setTab("list");
      list.refetch();
      onChanged();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Apple Ads names"
      description="Campaign, ad group and keyword names shown instead of Apple Ads ids. A connected Adsflare fills them automatically."
      footer={
        tab === "list" ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button disabled={!changed.length} loading={busy} onClick={() => save(changed)}>
              Save {changed.length ? `${changed.length} ${changed.length === 1 ? "change" : "changes"}` : "changes"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => setTab("list")}>
              Back
            </Button>
            <Button disabled={!Array.isArray(parsed) || !parsed.length} loading={busy} onClick={() => Array.isArray(parsed) && save(parsed)}>
              Import {Array.isArray(parsed) && parsed.length ? `${parsed.length} ${parsed.length === 1 ? "name" : "names"}` : ""}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4 p-5">
        <Segmented
          label="View"
          value={tab}
          onChange={setTab}
          options={[
            { value: "list", label: `Names${names.length ? ` (${names.length})` : ""}` },
            { value: "import", label: "Import" },
          ]}
        />
        {tab === "import" ? (
          <>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Paste CSV or TSV lines <code className="font-mono text-xs">kind,id,name</code> (kind: campaign, adgroup or keyword) or JSON{" "}
              <code className="font-mono text-xs">[{"{"} "kind", "id", "name" {"}"}]</code>. An empty name removes it. Apple Ads exports work once their columns are in this order.
            </p>
            <Textarea
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={"campaign,1234567,Brand search\nadgroup,2345678,Exact match\nkeyword,3456789,photo editor"}
              className="font-mono text-xs"
              aria-label="Names to import"
            />
            {!Array.isArray(parsed) ? (
              <p className="text-sm text-red-600 dark:text-red-400">{parsed.error}</p>
            ) : parsed.length ? (
              <p className="text-sm text-zinc-500">
                {ADS_NAME_KINDS.map((k) => [k, parsed.filter((n) => n.kind === k).length] as const)
                  .filter(([, n]) => n)
                  .map(([k, n]) => `${n} ${KIND_LABELS[k].toLowerCase()}${n === 1 ? "" : "s"}`)
                  .join(", ")}
              </p>
            ) : null}
          </>
        ) : list.loading && !list.data ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : names.length === 0 ? (
          <p className="py-6 text-center text-sm text-zinc-500">
            No names yet. Connect Revflare in Adsflare, or{" "}
            <button type="button" className="text-brand-700 hover:underline dark:text-brand-400" onClick={() => setTab("import")}>
              import them
            </button>
            .
          </p>
        ) : (
          <>
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name or id" aria-label="Filter names" />
            <div className="-mx-5 max-h-[45vh] overflow-y-auto">
              <Table>
                <thead className="border-y border-zinc-100 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-800/30">
                  <tr>
                    <th className={th}>Kind</th>
                    <th className={th}>Id</th>
                    <th className={cn(th, "w-full")}>Name</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  {shown.slice(0, 500).map((n) => (
                    <tr key={key(n)}>
                      <td className={cn(td, "text-zinc-500")}>{KIND_LABELS[n.kind]}</td>
                      <td className={cn(td, "font-mono text-xs")}>{n.id}</td>
                      <td className={cn(td, "py-1.5")}>
                        <Input
                          value={edits[key(n)] ?? n.name}
                          onChange={(e) => setEdits((x) => ({ ...x, [key(n)]: e.target.value }))}
                          aria-label={`Name of ${KIND_LABELS[n.kind].toLowerCase()} ${n.id}`}
                          className="h-8"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              {shown.length > 500 && <p className="px-5 py-2 text-xs text-zinc-500">Showing 500 of {shown.length}: filter to find others.</p>}
            </div>
            <p className="text-xs text-zinc-500">Clear a name to remove it (the id shows as #id again).</p>
          </>
        )}
      </div>
    </Dialog>
  );
}
