import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Me, Permission } from "@shared/types";
import { api, setApiWorkspace } from "./api";

const STORAGE_KEY = "revflare:workspace";

function stored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
function remember(id: string | null) {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage disabled */
  }
}

export interface Session {
  me: Me;
  user: Me["user"];
  workspace: Me["workspace"];
  currency: string;
  can: (p: Permission) => boolean;
  switchWorkspace: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

/** Loads /me, picks the workspace (last used here, else the server's) and sends it as X-Workspace-Id from then on. */
export function SessionProvider({ children, onLogout, fallback }: { children: ReactNode; onLogout: () => void; fallback: (error: string | null, retry: () => void) => ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setApiWorkspace(stored());
      let data = await api.me.get();
      const want = stored();
      const pick = want && data.workspaces.some((w) => w.id === want) ? want : (data.workspace?.id ?? data.workspaces[0]?.id ?? null);
      if (pick !== data.workspace?.id || pick !== want) {
        setApiWorkspace(pick);
        remember(pick);
        if (pick !== data.workspace?.id) data = await api.me.get();
      }
      setApiWorkspace(data.workspace?.id ?? null);
      setMe(data);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const value = useMemo<Session | null>(() => {
    if (!me) return null;
    const perms = new Set(me.workspace?.permissions ?? []);
    return {
      me,
      user: me.user,
      workspace: me.workspace,
      currency: me.workspace?.currency ?? "USD",
      can: (p) => perms.has(p),
      switchWorkspace: async (id) => {
        remember(id);
        setApiWorkspace(id);
        const data = await api.me.get();
        setMe(data);
      },
      refresh: async () => {
        const data = await api.me.get();
        setMe(data);
      },
      logout: async () => {
        await api.auth.logout().catch(() => {});
        setApiWorkspace(null);
        onLogout();
      },
    };
  }, [me, onLogout]);

  if (!value) return <>{fallback(error, () => void load())}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = Array.from(parts[0])[0] ?? "";
  const last = parts.length > 1 ? (Array.from(parts[parts.length - 1])[0] ?? "") : (Array.from(parts[0])[1] ?? "");
  return (first + last).toUpperCase();
}
