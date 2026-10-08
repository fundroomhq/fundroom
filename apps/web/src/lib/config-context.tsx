import { createContext, type ReactNode, useContext } from "react";
import type { WebConfig } from "./config.js";

const WebConfigContext = createContext<WebConfig | undefined>(undefined);

export function WebConfigProvider({
  config,
  children,
}: {
  config: WebConfig;
  children: ReactNode;
}) {
  return <WebConfigContext.Provider value={config}>{children}</WebConfigContext.Provider>;
}

export function useWebConfig(): WebConfig {
  const value = useContext(WebConfigContext);
  if (value === undefined) throw new Error("useWebConfig() outside <WebConfigProvider>");
  return value;
}
