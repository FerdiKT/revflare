import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router";
import type { AuthStatus } from "@shared/types";
import { Layout } from "./components/Layout";
import { Logo } from "./components/Logo";
import { QuotaBanner } from "./components/QuotaBanner";
import { Button } from "./components/ui/Button";
import { ConfirmProvider } from "./components/ui/Confirm";
import { EmptyState } from "./components/ui/Misc";
import { ToastProvider } from "./components/ui/Toast";
import { api, UNAUTHORIZED_EVENT } from "./lib/api";
import { AppsProvider } from "./lib/apps";
import { useQuota } from "./lib/quota";
import { SessionProvider, useSession } from "./lib/session";
import { AcquisitionPage } from "./pages/AcquisitionPage";
import { AlertsPage } from "./pages/AlertsPage";
import { AppDetailPage } from "./pages/AppDetailPage";
import { AppleAdsPage } from "./pages/AppleAdsPage";
import { LtvPage } from "./pages/LtvPage";
import { AppsPage } from "./pages/AppsPage";
import { AtRiskPage } from "./pages/AtRiskPage";
import { AuthPage, MagicLinkPage } from "./pages/AuthPage";
import { ChartsPage } from "./pages/ChartsPage";
import { CohortsPage } from "./pages/CohortsPage";
import { CustomerPage } from "./pages/CustomerPage";
import { ForecastPage } from "./pages/ForecastPage";
import { GooglePlayPage } from "./pages/GooglePlayPage";
import { ImportsPage } from "./pages/ImportsPage";
import { InvitePage } from "./pages/InvitePage";
import { MetaIntegrationPage } from "./pages/MetaIntegrationPage";
import { RefundRequestsPage } from "./pages/RefundRequestsPage";
import { OfferingsPage } from "./pages/OfferingsPage";
import { OffersPage } from "./pages/OffersPage";
import { RemoteConfigPage } from "./pages/RemoteConfigPage";
import { EventsPage } from "./pages/EventsPage";
import { TestDevicesPage } from "./pages/TestDevicesPage";
import { KeyEventsPage } from "./pages/KeyEventsPage";
import { ExperimentPage, ExperimentsPage } from "./pages/ExperimentsPage";
import { FunnelReportPage, FunnelsPage } from "./pages/FunnelsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ReconciliationPage } from "./pages/ReconciliationPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TransactionsPage } from "./pages/TransactionsPage";
import { AdminOverviewPage } from "./pages/admin/AdminOverviewPage";
import { AdminSettingsPage } from "./pages/admin/AdminSettingsPage";
import { AdminUsersPage } from "./pages/admin/AdminUsersPage";
import { AdminWorkspacesPage } from "./pages/admin/AdminWorkspacesPage";
import { Building2 } from "lucide-react";

export function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const check = useCallback(() => {
    setError(null);
    api.auth
      .status()
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    check();
    const onUnauthorized = () => setStatus((s) => (s ? { ...s, authenticated: false } : s));
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [check]);

  const onLogout = useCallback(() => {
    setStatus((s) => ({ ...s, setup: true, authenticated: false }));
    navigate("/", { replace: true });
  }, [navigate]);
  const onSignedIn = useCallback(() => setStatus((s) => ({ ...s, setup: true, authenticated: true })), []);

  return (
    <ToastProvider>
      <ConfirmProvider>
        {error && !status ? (
          <SplashError message={`Cannot reach the server: ${error}`} retry={check} />
        ) : !status ? (
          <Splash />
        ) : (
          <Routes>
            <Route path="/invite/:token" element={<InvitePage onDone={onSignedIn} />} />
            <Route path="/auth/link" element={status.setup && status.authenticated ? <Navigate to="/" replace /> : <MagicLinkPage onDone={onSignedIn} />} />
            <Route
              path="*"
              element={
                !status.setup || !status.authenticated ? (
                  <AuthPage
                    mode={status.setup ? "login" : "setup"}
                    setupToken={!!status.setupToken}
                    magicLink={!!status.magicLink}
                    appLogin={status.appLogin ? { push: !!status.pushLogin, appStoreUrl: status.appStoreUrl } : null}
                    onDone={onSignedIn}
                  />
                ) : (
                  <SessionProvider
                    onLogout={onLogout}
                    fallback={(err, retry) =>
                      err ? (
                        <SplashError message={`Could not load your account: ${err}`} retry={retry} />
                      ) : (
                        <Splash />
                      )
                    }
                  >
                    <WorkspaceScope />
                  </SessionProvider>
                )
              }
            />
          </Routes>
        )}
      </ConfirmProvider>
    </ToastProvider>
  );
}

/** Everything below is keyed by the workspace: switching remounts it, dropping cached data. */
function WorkspaceScope() {
  const { workspace, user } = useSession();
  return (
    <AppsProvider key={workspace?.id ?? "none"}>
      <Routes>
        <Route element={<Layout />}>
          {workspace ? (
            <>
              <Route index element={<OverviewPage />} />
              <Route path="charts" element={<ChartsPage />} />
              <Route path="transactions" element={<TransactionsPage />} />
              <Route path="customers/:id" element={<CustomerPage />} />
              <Route path="at-risk" element={<AtRiskPage />} />
              <Route path="cohorts" element={<CohortsPage />} />
              <Route path="forecast" element={<ForecastPage />} />
              <Route path="acquisition" element={<AcquisitionPage />} />
              <Route path="apple-ads" element={<AppleAdsPage />} />
              <Route path="ltv" element={<LtvPage />} />
              <Route path="apps" element={<AppsPage />} />
              <Route path="apps/:id" element={<AppDetailPage />} />
              <Route path="apps/:id/google-play" element={<GooglePlayPage />} />
              <Route path="apps/:id/integrations/meta" element={<MetaIntegrationPage />} />
              <Route path="apps/:id/integrations/refunds" element={<RefundRequestsPage />} />
              <Route path="apps/:id/offerings" element={<OfferingsPage />} />
              <Route path="apps/:id/offers" element={<OffersPage />} />
              <Route path="apps/:id/config" element={<RemoteConfigPage />} />
              <Route path="apps/:id/experiments" element={<ExperimentsPage />} />
              <Route path="apps/:id/experiments/:eid" element={<ExperimentPage />} />
              <Route path="apps/:id/events" element={<EventsPage />} />
              <Route path="apps/:id/funnels" element={<FunnelsPage />} />
              <Route path="apps/:id/test-devices" element={<TestDevicesPage />} />
              <Route path="apps/:id/key-events" element={<KeyEventsPage />} />
              <Route path="apps/:id/funnels/:fid" element={<FunnelReportPage />} />
              <Route path="reconciliation" element={<ReconciliationPage />} />
              <Route path="imports" element={<ImportsPage />} />
              <Route path="alerts" element={<AlertsPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="settings/:tab" element={<SettingsPage />} />
            </>
          ) : (
            <>
              <Route path="settings" element={<SettingsPage />} />
              <Route path="settings/:tab" element={<SettingsPage />} />
              <Route index element={<NoWorkspace />} />
            </>
          )}
          {user.isAdmin && (
            <>
              <Route path="admin" element={<AdminOverviewPage />} />
              <Route path="admin/users" element={<AdminUsersPage />} />
              <Route path="admin/workspaces" element={<AdminWorkspacesPage />} />
              <Route path="admin/settings" element={<AdminSettingsPage />} />
            </>
          )}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AppsProvider>
  );
}

function NoWorkspace() {
  return (
    <EmptyState
      icon={<Building2 />}
      title="You are not in a workspace yet"
      description="Ask a workspace owner for an invitation link, or create a workspace from the switcher in the sidebar if you are the instance admin."
    />
  );
}

/** Start-up failure: the daily database limit gets its banner, anything else the message and a retry. */
function SplashError({ message, retry }: { message: string; retry: () => void }) {
  const quota = useQuota();
  return (
    <Splash>
      {quota ? (
        <QuotaBanner className="max-w-xl text-left" onRetry={retry} />
      ) : (
        <>
          <p className="text-sm text-zinc-500">{message}</p>
          <Button className="mt-3" onClick={retry}>
            Try again
          </Button>
        </>
      )}
    </Splash>
  );
}

export function Splash({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-6">
      <Logo className="size-11 animate-pulse" />
      {children && <div className="mt-4 text-center">{children}</div>}
    </div>
  );
}
