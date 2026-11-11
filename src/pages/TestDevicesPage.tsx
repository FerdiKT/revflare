import { useState } from "react";
import { useParams } from "react-router";
import { Plus, Smartphone, Trash2 } from "lucide-react";
import { TEST_INSTALLS_LIMIT } from "@shared/types";
import { Button, IconButton } from "../components/ui/Button";
import { Input } from "../components/ui/Form";
import { Card, CardHeader, EmptyState, ErrorState, PageHeader, Skeleton } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { useFetch } from "../lib/useFetch";
import { BackToApp } from "./EventsPage";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Apps → app → Test devices: install ids left out of events, funnels, experiments, LTV and attribution (like sandbox / Xcode builds). */
export function TestDevicesPage() {
  const { id = "" } = useParams();
  const { can } = useSession();
  const manage = can("manage");
  const toast = useToast();
  const app = useFetch(`app:${id}`, () => api.apps.get(id), { tags: ["apps"] });
  const r = useFetch(`test-devices:${id}`, () => api.apps.testDevices.get(id));
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const ids = r.data?.installIds ?? [];
  const candidate = draft.trim().toLowerCase();
  const error = !candidate ? null : !UUID_RE.test(candidate) ? "An install id is a UUID (Revflare.installId)" : ids.includes(candidate) ? "Already listed" : null;

  const save = async (next: string[], ok: string) => {
    setBusy(true);
    try {
      const res = await api.apps.testDevices.replace(id, next);
      r.setData(() => res);
      toast.success(ok);
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <BackToApp id={id} name={app.data?.name} />
      <PageHeader
        title="Test devices"
        description="Install ids (Revflare.installId) of your own devices. Their events, installs and purchases are left out of events, funnels, experiments, insights, LTV, attributed revenue and Meta sending, like data from sandbox (TestFlight / development) and Xcode builds, which RevflareKit marks on its own."
      />
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} />}
      {!r.data && !r.error && <Skeleton className="h-40" />}
      {r.data && (
        <Card className="overflow-hidden">
          <CardHeader title={`${ids.length} of ${TEST_INSTALLS_LIMIT}`} description="Events and funnels can still show them with “Include test data”." />
          {manage && (
            <form
              className="flex flex-wrap items-start gap-2 border-t border-zinc-100 px-5 py-4 dark:border-zinc-800"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!candidate || error) return;
                if (await save([...ids, candidate], "Test device added")) setDraft("");
              }}
            >
              <div className="min-w-72 flex-1">
                <Input aria-label="Install id" className="font-mono text-xs" placeholder="00000000-0000-4000-8000-000000000000" value={draft} invalid={!!error} onChange={(e) => setDraft(e.target.value)} />
                {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
              </div>
              <Button type="submit" icon={<Plus className="size-4" />} loading={busy} disabled={!candidate || !!error || ids.length >= TEST_INSTALLS_LIMIT}>
                Add
              </Button>
            </form>
          )}
          {ids.length === 0 ? (
            <EmptyState icon={<Smartphone />} title="No test devices" description="Show Revflare.installId in a debug menu of your app, then add it here." />
          ) : (
            <ul className="divide-y divide-zinc-100 border-t border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
              {ids.map((x) => (
                <li key={x} className="flex items-center gap-3 px-5 py-2.5">
                  <Smartphone className="size-4 text-zinc-400" />
                  <span className="flex-1 font-mono text-xs">{x}</span>
                  {manage && (
                    <IconButton label="Remove" size="sm" variant="danger" disabled={busy} onClick={() => save(ids.filter((y) => y !== x), "Test device removed")}>
                      <Trash2 className="size-4" />
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </>
  );
}
