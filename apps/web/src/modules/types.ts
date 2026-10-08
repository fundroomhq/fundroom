import type { ComponentType } from "react";

/** Props a module's lazily loaded page component receives (see `registry.ts`). */
export interface ModulePageProps {
  readonly moduleId: string;
  readonly splat: string;
  readonly surface: "investor" | "admin";
}

export type ModuleLoader = () => Promise<{ default: ComponentType<ModulePageProps> }>;
