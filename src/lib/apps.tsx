import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { App } from "@shared/types";
import { api } from "./api";
import { useFetch } from "./useFetch";

interface AppsCtx {
  apps: App[];
  loading: boolean;
  error: Error | undefined;
  byId: Map<string, App>;
  currency: string | null;
}

const Ctx = createContext<AppsCtx>({ apps: [], loading: true, error: undefined, byId: new Map(), currency: null });

/** The workspace's apps (for pickers, icons and names), refreshed when "apps" is invalidated. */
export function AppsProvider({ children }: { children: ReactNode }) {
  const { data, loading, error } = useFetch("apps", api.apps.list, { tags: ["apps"] });
  const value = useMemo<AppsCtx>(() => {
    const apps = data?.items ?? [];
    return { apps, loading: loading && !data, error, byId: new Map(apps.map((a) => [a.id, a])), currency: data?.currency ?? null };
  }, [data, loading, error]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApps(): AppsCtx {
  return useContext(Ctx);
}
