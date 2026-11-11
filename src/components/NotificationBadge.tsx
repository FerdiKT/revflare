import { CircleDashed, History, Radio, Rocket } from "lucide-react";
import type { App } from "@shared/types";
import { Badge } from "./ui/Misc";

/** Where an app's sales come from: live notifications, Apple's notification history, not released, or nothing. */
export function NotificationBadge({ app }: { app: Pick<App, "notificationUrlStatus" | "storeAvailable" | "currentNotificationUrl"> & Partial<Pick<App, "platform" | "googlePlay" | "lastNotificationAt">> }) {
  if (app.platform === "android") {
    const g = app.googlePlay;
    if (g?.lastCheck && !g.lastCheck.ok)
      return (
        <Badge tone="red" icon={<CircleDashed />} title={`The Google Play service account check failed: ${g.lastCheck.error ?? "unknown error"}`}>
          Play API error
        </Badge>
      );
    if (app.lastNotificationAt)
      return (
        <Badge tone="green" icon={<Radio />} title="Google Play sends real-time developer notifications to Revflare.">
          Live
        </Badge>
      );
    return (
      <Badge tone="amber" icon={<CircleDashed />} title={g?.configured ? "No real-time developer notification received yet." : "Add a Google Play service account key and set up real-time developer notifications."}>
        {g?.configured ? "Waiting for notifications" : "Not set up"}
      </Badge>
    );
  }
  if (app.storeAvailable === false)
    return (
      <Badge tone="zinc" icon={<Rocket />} title="Apple has no production data for this app yet: it has not been released.">
        Not released
      </Badge>
    );
  switch (app.notificationUrlStatus) {
    case "revflare":
      return (
        <Badge tone="green" icon={<Radio />} title="Apple sends App Store Server Notifications straight to Revflare.">
          Live
        </Badge>
      );
    case "other":
      return (
        <Badge tone="blue" icon={<History />} title={`Notifications go to ${app.currentNotificationUrl ?? "another service"} (e.g. RevenueCat). Revflare reads Apple's notification history instead.`}>
          Synced from history
        </Badge>
      );
    case "none":
      return (
        <Badge tone="amber" icon={<CircleDashed />} title="No App Store Server Notification URL is set for this app.">
          Not connected
        </Badge>
      );
    default:
      return (
        <Badge tone="zinc" icon={<CircleDashed />} title="Revflare could not read the notification URL (add an App Store Connect key).">
          Unknown
        </Badge>
      );
  }
}
