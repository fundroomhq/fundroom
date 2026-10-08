import { createFileRoute, redirect } from "@tanstack/react-router";
import { ModulePage } from "../../components/module-page.js";
import { investorModuleFor, movedInvestorSplat } from "../../modules/investor-paths.js";
import { investorModules } from "../../modules/registry.js";

export const Route = createFileRoute("/_portal/$")({
  /*
   * E-UP-18 D3: an investor page that moved (`/metrics` → `/kpis`) is followed inside the app,
   * for links and history from before the move. A full page load of the old path never gets
   * here — the server answers `/metrics` itself.
   */
  beforeLoad: ({ params, location }) => {
    const moved = movedInvestorSplat(params._splat ?? "");
    if (moved === undefined) return;
    throw redirect({
      to: "/$",
      params: { _splat: moved },
      search: location.search,
      hash: location.hash,
      replace: true,
    });
  },
  component: Splat,
});

function Splat() {
  const { _splat } = Route.useParams();
  return (
    <ModulePage
      splat={_splat ?? ""}
      surface="investor"
      registry={investorModules}
      moduleFor={investorModuleFor}
    />
  );
}
