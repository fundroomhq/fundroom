import { Alert, AlertDescription, AlertTitle, LoadingState, PageHeader } from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldOff } from "lucide-react";
import { AiSettingsBody } from "../../../components/ai-admin/settings.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { aiStatusQuery } from "../../../lib/ai-queries.js";
import { useBootstrap } from "../../../lib/queries.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/settings/ai")({ component: AiSettingsPage });

/*
 * AI assist (E3.12, ADR-0060): which model the host configured (if any) and where it runs, the
 * workspace's opt-in (master switch, per-feature switches, a monthly token budget) and this
 * month's usage. `ai.read` sees it, `ai.manage` changes it (with a fresh session: a stale one is
 * sent to step-up by the guarded mutation).
 */
function AiSettingsPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  const allowed = permissions.includes("ai.read");
  const canManage = permissions.includes("ai.manage");
  const status = useQuery({ ...aiStatusQuery, enabled: allowed });
  if (!allowed) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.ai_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="space-y-6">
      <PageHeader title={m.ai_title()} description={m.ai_subtitle()} />
      <p className="text-sm">
        <Link to="/admin/settings" className="underline underline-offset-4">
          {m.adminsettings_back()}
        </Link>
      </p>
      {status.isPending ? <LoadingState lines={4} label={m.common_loading()} /> : null}
      {status.isError ? <ErrorAlert error={status.error} /> : null}
      {status.data ? <AiSettingsBody status={status.data} canManage={canManage} /> : null}
    </div>
  );
}
