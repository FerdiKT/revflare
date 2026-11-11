import { useState, type ReactNode } from "react";
import { Mail, Send, TriangleAlert } from "lucide-react";
import type { AdminEmailSettings } from "@shared/types";
import { Button } from "../../components/ui/Button";
import { Switch } from "../../components/ui/Form";
import { Card, CardHeader, ErrorState, PageHeader, Skeleton } from "../../components/ui/Misc";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { useFetch } from "../../lib/useFetch";

const Code = ({ children }: { children: ReactNode }) => <code className="font-mono text-xs break-all">{children}</code>;

/** Admin → Settings: instance-wide settings (sign-in links by email). */
export function AdminSettingsPage() {
  const r = useFetch("admin-email", api.admin.email, { tags: ["admin"] });
  return (
    <>
      <PageHeader title="Settings" description="Settings of this Revflare server, for every workspace. Only instance admins see this." />
      {r.error && <ErrorState error={r.error} onRetry={r.refetch} className="mb-6" />}
      <EmailCard settings={r.data ?? null} onChange={r.refetch} />
    </>
  );
}

function EmailCard({ settings, onChange }: { settings: AdminEmailSettings | null; onChange: () => void }) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const toggle = async (enabled: boolean) => {
    setSaving(true);
    try {
      await api.admin.updateEmail(enabled);
      toast.success(enabled ? "Sign-in links by email are on" : "Sign-in links by email are off");
      onChange();
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };
  const test = async () => {
    setTesting(true);
    try {
      const r = await api.admin.testEmail();
      toast.success("Test email sent", `Check the inbox of ${r.to}.`);
    } catch (err) {
      toast.error("The test email was not sent", (err as Error).message);
    } finally {
      setTesting(false);
    }
  };
  return (
    <Card className="max-w-3xl">
      <CardHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Mail className="size-4 text-zinc-400" /> Sign-in links by email
          </span>
        }
        description="Users can request a one-time sign-in link instead of typing their password."
        action={settings?.configured ? <Switch checked={settings.enabled} onChange={toggle} disabled={saving} label="Sign-in links by email" /> : undefined}
      />
      <div className="space-y-4 px-5 pb-5 text-sm">
        <p className="flex gap-2 rounded-xl bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            Needs Cloudflare Workers Paid ($5/month) and a domain onboarded to Cloudflare Email Sending. On the Free plan emails only reach your account's verified
            addresses.
          </span>
        </p>
        {!settings ? (
          <Skeleton className="h-16" />
        ) : !settings.configured ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <p className="text-zinc-500 dark:text-zinc-400">Email is not set up on this deployment.</p>
              <Switch checked={false} onChange={() => {}} disabled label="Sign-in links by email" />
            </div>
            <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-zinc-600 dark:text-zinc-300">
              <li>
                Onboard the sender's domain to Cloudflare Email Sending (Compute → Email Service → Email Sending, or <Code>npx wrangler email sending enable example.com</Code>).
              </li>
              <li>
                In <Code>wrangler.local.jsonc</Code>, add the binding <Code>"send_email": [{'{ "name": "EMAIL", "remote": true }'}]</Code> and the variable{" "}
                <Code>"EMAIL_FROM": "Revflare &lt;revflare@example.com&gt;"</Code>.
              </li>
              <li>
                Deploy (<Code>npm run deploy</Code>), then turn the switch on here.
              </li>
            </ol>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-zinc-500 dark:text-zinc-400">
              Sender: <span className="font-medium text-zinc-900 dark:text-zinc-100">{settings.from}</span>
              {" · "}
              {settings.enabled ? "On: the sign-in page offers \"Email me a sign-in link\"." : "Off."}
            </p>
            <Button icon={<Send className="size-4" />} loading={testing} onClick={test}>
              Send test email
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}
