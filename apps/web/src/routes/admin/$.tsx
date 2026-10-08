import { createFileRoute } from "@tanstack/react-router";
import { ModulePage } from "../../components/module-page.js";
import { adminModules } from "../../modules/registry.js";

export const Route = createFileRoute("/admin/$")({ component: AdminSplat });

function AdminSplat() {
  const { _splat } = Route.useParams();
  return <ModulePage splat={_splat ?? ""} surface="admin" registry={adminModules} />;
}
