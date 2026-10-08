import { createFileRoute } from "@tanstack/react-router";
import { SearchResultsPage, validateSearchParams } from "../../components/search/search-results.js";

/** Workspace search for members (E2.8): what this investor may see, and nothing else. */
export const Route = createFileRoute("/_portal/search")({
  validateSearch: validateSearchParams,
  component: PortalSearch,
});

function PortalSearch() {
  const { q } = Route.useSearch();
  return <SearchResultsPage q={q} to="/search" />;
}
