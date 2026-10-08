import { Button, EmptyState, ErrorState } from "@fundroomhq/ui";
import { Link } from "@tanstack/react-router";
import { ExternalLink, SearchX, Wrench } from "lucide-react";
import { openInNewTab } from "../embed/EmbedFrame.js";
import { describeError } from "../lib/api.js";
import { useWebConfig } from "../lib/config-context.js";
import { m } from "../paraglide/messages.js";

/** The one not-found screen: unknown URLs and forbidden trees render exactly this. */
export function NotFoundScreen() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <EmptyState
        icon={<SearchX aria-hidden="true" />}
        title={m.error_not_found_title()}
        description={m.error_not_found_body()}
        action={
          <Button asChild variant="outline">
            <Link to="/">{m.nav_home()}</Link>
          </Button>
        }
      />
    </div>
  );
}

export function SetupRequiredScreen() {
  const config = useWebConfig();
  /*
   * `min-h-svh` is a full *viewport* height, and inside a loader-managed iframe the viewport is
   * the iframe — so the frame reports its own height back over `resize`, the loader grows the
   * iframe to match, and the new viewport height makes `min-h-svh` taller again. The embed tree
   * therefore sizes to its content, the way `_auth.tsx` already branches.
   */
  const embed = config.tree === "embed";
  return (
    <div
      className={
        embed
          ? "flex items-center justify-center p-6"
          : "flex min-h-svh items-center justify-center p-6"
      }
    >
      <EmptyState
        icon={<Wrench aria-hidden="true" />}
        title={m.setup_required_title()}
        description={m.setup_required_body({ name: config.instanceName })}
        action={
          <Button asChild>
            <a href={`${config.basePath}/setup`}>{m.setup_required_action()}</a>
          </Button>
        }
      />
    </div>
  );
}

export function RouteErrorScreen({ error, reset }: { error: unknown; reset?: () => void }) {
  const d = describeError(error);
  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <ErrorState
        title={d.title}
        description={d.body}
        requestId={d.requestId}
        requestIdLabel={m.common_request_id_label()}
        {...(reset ? { onRetry: reset, retryLabel: m.common_retry() } : {})}
      />
    </div>
  );
}

export function EmbedAdminBlocked() {
  const config = useWebConfig();
  return (
    <div className="p-6">
      <EmptyState
        title={m.embed_admin_blocked_title()}
        description={m.embed_admin_blocked_body()}
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => openInNewTab(config.canonicalOrigin, "/admin")}
          >
            <ExternalLink aria-hidden="true" />
            {m.embed_open_admin()}
          </Button>
        }
      />
    </div>
  );
}
