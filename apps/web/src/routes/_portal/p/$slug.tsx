import { LoadingState, PageHeader } from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageRenderer } from "../../../components/content/page-renderer.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { NotFoundScreen } from "../../../components/status-screens.js";
import { isCode } from "../../../lib/api.js";
import { renderedPageQuery, useBootstrap } from "../../../lib/queries.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/_portal/p/$slug")({ component: CustomPage });

/** A published custom content page at `/p/<slug>` (E1.2). */
function CustomPage() {
  const { slug } = Route.useParams();
  const page = useQuery(renderedPageQuery(slug));
  const bootstrap = useBootstrap();
  if (page.isPending) return <LoadingState label={m.common_loading()} />;
  if (page.isError) {
    return isCode(page.error, "not_found") ? <NotFoundScreen /> : <ErrorAlert error={page.error} />;
  }
  return (
    <div className="space-y-8">
      <PageHeader title={page.data.page.title} />
      <PageRenderer page={page.data} showAudience={bootstrap.data?.membership?.kind === "staff"} />
    </div>
  );
}
