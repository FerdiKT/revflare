import { useState } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import type { App } from "@shared/types";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Form";
import { Card, CardHeader, CopyField } from "../components/ui/Misc";
import { useToast } from "../components/ui/Toast";
import { api } from "../lib/api";
import { ago, dateTime } from "../lib/format";
import { invalidate, useFetch } from "../lib/useFetch";

/** A web app's Polar setup: webhook URL, signing secret / access token, product map, order import (docs/polar.md). */
export function PolarCard({
  app,
  now,
  manage,
}: {
  app: App;
  now: number;
  manage: boolean;
}) {
  const toast = useToast();
  const r = useFetch(`polar:${app.id}`, () => api.apps.polar.get(app.id), {
    tags: ["apps"],
  });
  const p = r.data;
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (
    name: string,
    fn: () => Promise<unknown>,
    ok: string,
    desc?: (res: unknown) => string | undefined,
  ) => {
    setBusy(name);
    try {
      const res = await fn();
      toast.success(ok, desc?.(res));
      setSecret("");
      setToken("");
      invalidate("apps", "metrics");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card className="lg:col-span-2">
      <CardHeader
        title="Polar"
        description="How Revflare hears about this website's sales: Polar webhooks (orders, refunds, subscriptions)."
      />
      <div className="space-y-4 px-5 pb-5">
        {!app.polar?.connected ? (
          <p className="flex gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" /> Not connected.
            Paste an organization access token (Revflare creates the webhook) or
            add the URL below as a webhook in Polar and paste its signing
            secret.
          </p>
        ) : app.lastNotificationAt ? (
          <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900">
            Live: Polar sends every order, refund and subscription change to
            Revflare.
          </p>
        ) : (
          <p className="rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-900 ring-1 ring-sky-200 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900">
            Connected; no webhook received yet.
          </p>
        )}
        <div>
          <p className="mb-1.5 text-xs font-medium text-zinc-500">
            Webhook URL (format Raw; events:{" "}
            {p?.events.join(", ") ?? "order.*, subscription.*"})
          </p>
          <CopyField value={app.revflareNotificationUrl} />
        </div>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-zinc-500">Last webhook</dt>
            <dd
              className="mt-0.5 font-medium"
              title={
                app.lastNotificationAt
                  ? dateTime(app.lastNotificationAt)
                  : undefined
              }
            >
              {app.lastNotificationAt
                ? ago(app.lastNotificationAt, now)
                : "Never"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Environment</dt>
            <dd className="mt-0.5 font-medium">
              {p?.sandbox ? "Sandbox" : "Production"}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-zinc-500">Products</dt>
            <dd
              className="mt-0.5 truncate font-mono text-xs font-medium"
              title={
                p
                  ? Object.entries(p.products)
                      .map(([k, v]) => `${k} → ${v}`)
                      .join("\n")
                  : undefined
              }
            >
              {p && Object.keys(p.products).length
                ? Object.values(p.products).join(", ")
                : "Polar ids"}
            </dd>
          </div>
        </dl>
        {manage && (
          <div className="space-y-3 border-t border-zinc-100 pt-4 dark:border-zinc-800">
            <div className="flex flex-wrap gap-2">
              <Input
                className="min-w-0 flex-1"
                type="password"
                placeholder={
                  p?.hasAccessToken
                    ? "Access token saved — paste to replace"
                    : "Polar organization access token (polar_oat_…)"
                }
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
              <Button
                disabled={!token.trim()}
                loading={busy === "token"}
                onClick={() =>
                  run(
                    "token",
                    () =>
                      api.apps.polar.update(app.id, {
                        accessToken: token.trim(),
                      }),
                    "Access token saved",
                    () => "Revflare created the Polar webhook if none was set.",
                  )
                }
              >
                Save token
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Input
                className="min-w-0 flex-1"
                type="password"
                placeholder={
                  app.polar?.connected
                    ? "Signing secret saved — paste to replace"
                    : "Webhook signing secret (whsec_…)"
                }
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
              <Button
                disabled={!secret.trim()}
                loading={busy === "secret"}
                onClick={() =>
                  run(
                    "secret",
                    () =>
                      api.apps.polar.update(app.id, {
                        webhookSecret: secret.trim(),
                      }),
                    "Signing secret saved",
                  )
                }
              >
                Save secret
              </Button>
            </div>
            {p?.hasAccessToken && (
              <Button
                variant="outline"
                icon={<RefreshCw className="size-4" />}
                loading={busy === "sync"}
                onClick={() =>
                  run(
                    "sync",
                    () => api.apps.polar.sync(app.id),
                    "Polar orders imported",
                    (res) => {
                      const x = res as {
                        orders: number;
                        stored: number;
                        error?: string;
                      };
                      return (
                        x.error ?? `${x.orders} orders, ${x.stored} new sales`
                      );
                    },
                  )
                }
              >
                Import past orders
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
