import { Alert, AlertDescription, AlertTitle } from "@fundroomhq/ui";
import { ShieldOff } from "lucide-react";
import { useBootstrap } from "../../lib/queries.js";
import { m } from "../../paraglide/messages.js";
import type { ModulePageProps } from "../types.js";
import { ChannelsScreen } from "./channels.js";
import { InboxScreen } from "./inbox.js";
import { PreferencesScreen } from "./preferences.js";

/*
 * Notifications, staff side. `/admin/notify` is the in-app inbox (unread count, mark read, mark
 * all read, archive, keyset "load more"); `/admin/notify/preferences` is the per-event cadence
 * form plus the email switch, timezone, digest hour, weekly day and quiet hours. Both are
 * per-operator, so no permission gate. `/admin/notify/channels` (E2.6) is the workspace's chat
 * channels, behind `notify.manage`: the link to it is hidden without the permission and the
 * screen says so rather than rendering a list the API would refuse.
 */
export default function NotifyAdmin({ splat }: ModulePageProps) {
  const [head] = splat.split("/").filter(Boolean);
  const bootstrap = useBootstrap();
  const canManageChannels = (bootstrap.data?.permissions ?? []).includes("notify.manage");
  if (head === "preferences") return <PreferencesScreen />;
  if (head === "channels") {
    return canManageChannels ? (
      <ChannelsScreen />
    ) : (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.notify_channels_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  return <InboxScreen canManageChannels={canManageChannels} />;
}
