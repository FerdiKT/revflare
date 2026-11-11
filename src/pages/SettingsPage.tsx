import { useEffect, useRef } from "react";
import { NavLink, Navigate, useParams } from "react-router";
import { Building2, KeyRound, Smartphone, Target, UserRound, Users, Vault } from "lucide-react";
import { PageHeader } from "../components/ui/Misc";
import { cn } from "../lib/format";
import { useSession } from "../lib/session";
import { AccountSettings } from "./settings/AccountSettings";
import { ApiKeysSettings } from "./settings/ApiKeysSettings";
import { CredentialsSettings } from "./settings/CredentialsSettings";
import { GoalsSettings } from "./settings/GoalsSettings";
import { IosSettings } from "./settings/IosSettings";
import { MembersSettings } from "./settings/MembersSettings";
import { WorkspaceSettings } from "./settings/WorkspaceSettings";

const TABS = [
  { id: "workspace", label: "Workspace", icon: Building2, ws: true },
  { id: "credentials", label: "Store credentials", icon: Vault, ws: true, permission: "manage" as const },
  { id: "goals", label: "Goals", icon: Target, ws: true },
  { id: "api-keys", label: "API keys", icon: KeyRound, ws: true },
  { id: "members", label: "Members", icon: Users, ws: true },
  { id: "ios", label: "iOS app", icon: Smartphone, ws: true },
  { id: "account", label: "Account", icon: UserRound },
];

export function SettingsPage() {
  const { tab } = useParams();
  const { workspace, can } = useSession();
  const tabs = TABS.filter((t) => (!t.ws || workspace) && (!t.permission || can(t.permission)));
  const current = tabs.find((t) => t.id === tab);
  const nav = useRef<HTMLElement>(null);
  // Phones: the tab row scrolls; keep the current tab in view.
  useEffect(() => {
    const el = nav.current?.querySelector<HTMLElement>('[aria-current="page"]');
    const box = nav.current;
    if (el && box && box.scrollWidth > box.clientWidth) box.scrollLeft = el.offsetLeft - 16;
  }, [tab]);
  // The Usage tab moved to Admin → Overview.
  if (tab === "usage") return <Navigate to="/admin" replace />;
  if (!current) return <Navigate to={`/settings/${tabs[0].id}`} replace />;

  return (
    <>
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-6 lg:flex-row lg:gap-10">
        <nav ref={nav} aria-label="Settings" className="relative -mx-4 overflow-x-auto px-4 scrollbar-thin lg:mx-0 lg:w-52 lg:shrink-0 lg:overflow-visible lg:px-0">
          <ul className="flex gap-1 lg:flex-col">
            {tabs.map((t) => (
              <li key={t.id}>
                <NavLink
                  to={`/settings/${t.id}`}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap transition",
                      isActive ? "bg-white text-zinc-900 shadow-xs ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-white dark:ring-zinc-800" : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
                    )
                  }
                >
                  <t.icon className="size-4 text-zinc-400" />
                  {t.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 flex-1">
          {current.id === "workspace" && <WorkspaceSettings />}
          {current.id === "credentials" && <CredentialsSettings />}
          {current.id === "goals" && <GoalsSettings />}
          {current.id === "api-keys" && <ApiKeysSettings />}
          {current.id === "members" && <MembersSettings />}
          {current.id === "ios" && <IosSettings />}
          {current.id === "account" && <AccountSettings />}
        </div>
      </div>
    </>
  );
}

/** Settings section: title, description, content card. */
export function Section({ title, description, children, action }: { title: string; description?: React.ReactNode; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="mt-0.5 max-w-2xl text-sm text-zinc-500 dark:text-zinc-400">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
