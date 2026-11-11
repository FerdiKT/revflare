import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import {
  Activity,
  AppWindow,
  BarChart3,
  Bell,
  Building2,
  Check,
  ChevronsUpDown,
  Compass,
  DownloadCloud,
  Gauge,
  Gem,
  Grid3x3,
  LifeBuoy,
  LogOut,
  Megaphone,
  Menu,
  Users,
  Plus,
  Scale,
  Server,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  X,
  type LucideIcon,
} from "lucide-react";
import { api } from "../lib/api";
import { useApps } from "../lib/apps";
import { useGlobalSearch } from "../lib/filters";
import { cn } from "../lib/format";
import { initials, useSession } from "../lib/session";
import { useFetch } from "../lib/useFetch";
import { Wordmark } from "./Logo";
import { QuotaBanner } from "./QuotaBanner";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";
import { Field, Input } from "./ui/Form";
import { Popover } from "./ui/Popover";
import { useToast } from "./ui/Toast";
import { CurrencySelect } from "./CurrencySelect";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  filters?: boolean;
  /** App Store only (hidden when every app of the workspace is an Android app). */
  ios?: boolean;
}

const NAV: Array<{ title?: string; items: NavItem[] }> = [
  {
    items: [
      { to: "/", label: "Overview", icon: Gauge, end: true, filters: true },
      { to: "/charts", label: "Charts", icon: BarChart3, filters: true },
      { to: "/transactions", label: "Transactions", icon: Activity, filters: true },
    ],
  },
  {
    title: "Insights",
    items: [
      { to: "/at-risk", label: "At risk", icon: LifeBuoy, filters: true },
      { to: "/cohorts", label: "Cohorts", icon: Grid3x3, filters: true },
      { to: "/forecast", label: "Forecast", icon: TrendingUp, filters: true },
      { to: "/acquisition", label: "Acquisition", icon: Compass, filters: true, ios: true },
      { to: "/apple-ads", label: "Apple Ads", icon: Megaphone, filters: true, ios: true },
      { to: "/ltv", label: "LTV", icon: Gem, filters: true },
    ],
  },
  {
    title: "Setup",
    items: [
      { to: "/apps", label: "Apps", icon: AppWindow },
      { to: "/reconciliation", label: "Reconciliation", icon: Scale, filters: true },
      { to: "/imports", label: "Imports", icon: DownloadCloud },
      { to: "/alerts", label: "Alerts", icon: Bell },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

/** Instance administration: only shown to instance admins. */
const ADMIN_NAV: { title: string; items: NavItem[] } = {
  title: "Admin",
  items: [
    { to: "/admin", label: "Overview", icon: ShieldCheck, end: true },
    { to: "/admin/users", label: "Users", icon: Users },
    { to: "/admin/workspaces", label: "Workspaces", icon: Server },
    { to: "/admin/settings", label: "Settings", icon: SlidersHorizontal },
  ],
};

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-zinc-200/80 bg-white/70 backdrop-blur lg:block dark:border-zinc-800/80 dark:bg-zinc-900/50">
        <Sidebar />
      </aside>

      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-zinc-200 bg-white/85 px-4 backdrop-blur lg:hidden dark:border-zinc-800 dark:bg-zinc-900/85">
        <button onClick={() => setMobileOpen(true)} className="-ml-2 rounded-lg p-2 text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800" aria-label="Open menu">
          <Menu className="size-5" />
        </button>
        <Wordmark />
        <span className="size-9" />
      </header>

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-zinc-950/40" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 animate-fade-in bg-white shadow-xl dark:bg-zinc-900" aria-label="Menu">
            <button onClick={() => setMobileOpen(false)} className="absolute top-3.5 right-3 z-10 rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800" aria-label="Close menu">
              <X className="size-5" />
            </button>
            <Sidebar />
          </aside>
        </div>
      )}

      <main className="lg:pl-64">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-10 lg:py-9">
          <QuotaBanner className="mb-6" />
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function Sidebar() {
  const { user, logout, workspace } = useSession();
  const search = useGlobalSearch();
  const alerts = useFetch(workspace ? "alerts" : null, api.alerts.list, { tags: ["alerts"], refreshMs: 120_000 });
  const open = alerts.data?.items.filter((a) => !a.resolvedAt).length ?? 0;
  const { apps } = useApps();
  const androidOnly = apps.length > 0 && apps.every((a) => a.platform === "android");

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center px-5">
        <Wordmark />
      </div>
      <div className="px-3 pb-3">
        <WorkspaceSwitcher />
      </div>
      <nav className="flex-1 overflow-y-auto px-3 pb-3 scrollbar-thin" aria-label="Main">
        {[...NAV, ...(user.isAdmin ? [ADMIN_NAV] : [])].map((g, gi) => (
          <div key={gi} className={gi ? "mt-5" : ""}>
            {g.title && <p className="px-3 pb-1.5 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase dark:text-zinc-500">{g.title}</p>}
            <div className="space-y-0.5">
              {g.items.filter((item) => !(item.ios && androidOnly)).map((item) => (
                <NavItemLink
                  key={item.to}
                  item={item}
                  search={item.filters ? search : ""}
                  badge={
                    item.to === "/alerts" && open > 0 ? (
                      <span className="rounded-full bg-brand-600 px-1.5 text-[10px] leading-4 font-semibold text-white tabular-nums dark:bg-brand-500" aria-label={`${open} open`}>
                        {open}
                      </span>
                    ) : undefined
                  }
                />
              ))}
            </div>
          </div>
        ))}
      </nav>
      <div className="flex items-center gap-1 border-t border-zinc-200/80 p-3 dark:border-zinc-800">
        <NavLink
          to="/settings/account"
          className={({ isActive }) => cn("flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 transition-colors", isActive ? "bg-zinc-100 dark:bg-zinc-800" : "hover:bg-zinc-100/70 dark:hover:bg-zinc-800/50")}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-amber-400 text-xs font-semibold text-white">{initials(user.name)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">{user.name}</span>
            <span className="block truncate text-xs text-zinc-500">{user.email}</span>
          </span>
        </NavLink>
        <button onClick={() => void logout()} title="Log out" aria-label="Log out" className="rounded-lg p-2 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
          <LogOut className="size-[18px]" />
        </button>
      </div>
    </div>
  );
}

function NavItemLink({ item, badge, search }: { item: NavItem; badge?: React.ReactNode; search: string }) {
  const { to, label, icon: Icon, end } = item;
  return (
    <NavLink
      to={`${to}${search}`}
      end={end}
      className={({ isActive }) =>
        cn(
          "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
          isActive ? "bg-zinc-900/[0.05] text-zinc-900 dark:bg-white/[0.07] dark:text-white" : "text-zinc-600 hover:bg-zinc-900/[0.03] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-zinc-100",
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon className={cn("size-[18px]", isActive ? "text-brand-600 dark:text-brand-400" : "text-zinc-400 group-hover:text-zinc-500 dark:text-zinc-500")} />
          <span className="flex-1">{label}</span>
          {badge}
        </>
      )}
    </NavLink>
  );
}

function WorkspaceSwitcher() {
  const { workspace, me, switchWorkspace, user } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [creating, setCreating] = useState(false);

  return (
    <>
      <Popover
        label="Workspaces"
        className="w-full"
        panelClassName="inset-x-0"
        trigger={(p) => (
          <button
            ref={p.ref}
            onClick={p.toggle}
            aria-expanded={p["aria-expanded"]}
            aria-haspopup="dialog"
            className="flex w-full items-center gap-2.5 rounded-xl bg-white px-2 py-2 text-left shadow-xs ring-1 ring-zinc-200 transition hover:bg-zinc-50 dark:bg-zinc-900 dark:ring-zinc-800 dark:hover:bg-zinc-800/60"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-xs font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900">
              {workspace ? initials(workspace.name) : <Building2 className="size-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{workspace?.name ?? "No workspace"}</span>
              <span className="block truncate text-xs text-zinc-500 capitalize">{workspace ? `${workspace.role} · ${workspace.currency}` : "Not a member yet"}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-zinc-400" />
          </button>
        )}
      >
        {(close) => (
          <div>
            <p className="px-2 pt-1 pb-1 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">Workspaces</p>
            {me.workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={async () => {
                  close();
                  if (w.id === workspace?.id) return;
                  try {
                    await switchWorkspace(w.id);
                    navigate("/");
                  } catch (err) {
                    toast.error(err);
                  }
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-zinc-200 text-[10px] font-semibold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">{initials(w.name)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{w.name}</span>
                  <span className="block truncate text-xs text-zinc-500 capitalize">
                    {w.role} · {w.currency}
                  </span>
                </span>
                {w.id === workspace?.id && <Check className="size-4 shrink-0 text-brand-600 dark:text-brand-400" />}
              </button>
            ))}
            {user.isAdmin && (
              <>
                <div className="my-1.5 border-t border-zinc-100 dark:border-zinc-800" />
                <button
                  type="button"
                  onClick={() => {
                    close();
                    setCreating(true);
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  <Plus className="size-4 text-zinc-400" /> Create workspace
                </button>
              </>
            )}
          </div>
        )}
      </Popover>
      <CreateWorkspaceDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function CreateWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { switchWorkspace } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create workspace"
      description="A separate set of apps, credentials, members and API keys."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="create-ws" loading={busy}>
            Create
          </Button>
        </>
      }
    >
      <form
        id="create-ws"
        className="space-y-4 p-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const ws = await api.workspace.create(name, currency);
            await switchWorkspace(ws.id);
            toast.success("Workspace created");
            onClose();
            navigate("/apps");
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name" required error={error}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required data-autofocus />}
        </Field>
        <Field label="Reporting currency" help="Every amount is shown in this currency.">
          {(id) => <CurrencySelect id={id} value={currency} onChange={setCurrency} />}
        </Field>
      </form>
    </Dialog>
  );
}
