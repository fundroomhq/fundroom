import { createFileRoute } from "@tanstack/react-router";
import { SearchResultsPage, validateSearchParams } from "../../components/search/search-results.js";

/** Workspace search from the admin shell (E2.8): staff also find staff-only entries. */
export const Route = createFileRoute("/admin/search")({
  validateSearch: validateSearchParams,
  component: AdminSearch,
});

function AdminSearch() {
  const { q } = Route.useSearch();
  return <SearchResultsPage q={q} to="/admin/search" />;
}
