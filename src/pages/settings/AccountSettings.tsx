import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Field, Input, Switch } from "../../components/ui/Form";
import { Card, ErrorState } from "../../components/ui/Misc";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { useSession } from "../../lib/session";
import { Section } from "../SettingsPage";

export function AccountSettings() {
  const { user, refresh, me, logout } = useSession();
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [busy, setBusy] = useState(false);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [digestBusy, setDigestBusy] = useState(false);
  const emailOn = !!me.features.email;

  return (
    <>
      <Section title="Profile" description={`Signed in as ${user.email}${user.isAdmin ? " · instance admin" : ""}.`}>
        <Card className="p-5">
          <form
            className="flex max-w-xl flex-wrap items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api.me.update(name);
                await refresh();
                toast.success("Name saved");
              } catch (err) {
                toast.error(err);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="Name" className="min-w-56 flex-1">
              {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />}
            </Field>
            <Button type="submit" variant="primary" loading={busy} disabled={name.trim() === user.name}>
              Save
            </Button>
          </form>
        </Card>
      </Section>
      <Section
        title="Daily digest email"
        description="Every morning: yesterday's revenue, proceeds, new subscriptions and trials per app, installs and paywall views when app events are set up, and the apps that moved most against their 7-day average."
      >
        <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
          <p className="max-w-xl text-sm text-zinc-500">
            {emailOn
              ? `Sent to ${user.email} after 09:00 in your iPhone's time zone (UTC without one).`
              : "This server cannot send email: an instance admin sets up Email Sending (EMAIL binding and EMAIL_FROM) first."}
          </p>
          <Switch
            label="Daily digest email"
            checked={!!user.dailyDigestEmail}
            disabled={digestBusy || (!emailOn && !user.dailyDigestEmail) || me.auth === "api_key"}
            onChange={async (v) => {
              setDigestBusy(true);
              try {
                await api.me.setDailyDigestEmail(v);
                await refresh();
                toast.success(v ? "Daily digest email on" : "Daily digest email off");
              } catch (err) {
                toast.error(err);
              } finally {
                setDigestBusy(false);
              }
            }}
          />
        </Card>
      </Section>
      <Section title="Password">
        <Card className="p-5">
          <form
            className="grid max-w-md gap-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setPwError(null);
              if (password !== confirmPw) return setPwError("The new passwords do not match");
              setPwBusy(true);
              try {
                await api.me.password(current, password);
                setCurrent("");
                setPassword("");
                setConfirmPw("");
                toast.success("Password changed");
              } catch (err) {
                setPwError((err as Error).message);
              } finally {
                setPwBusy(false);
              }
            }}
          >
            {pwError && <ErrorState error={pwError} />}
            <Field label="Current password">{(id) => <Input id={id} type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />}</Field>
            <Field label="New password" help="At least 8 characters.">
              {(id) => <Input id={id} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />}
            </Field>
            <Field label="Repeat the new password">{(id) => <Input id={id} type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} required autoComplete="new-password" />}</Field>
            <div>
              <Button type="submit" variant="primary" loading={pwBusy}>
                Change password
              </Button>
            </div>
          </form>
        </Card>
      </Section>
      <Section title="Session">
        <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
          <p className="text-sm text-zinc-500">
            Revflare {me.version} · API v{me.apiVersion}
          </p>
          <Button onClick={() => void logout()}>Log out</Button>
        </Card>
      </Section>
    </>
  );
}
