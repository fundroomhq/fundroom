import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// biome-ignore lint/correctness/useImportExtensions: stylesheet, bundled by Vite
import "./styles.css";
import { App } from "./app.js";
import { configureApi, createQueryClient } from "./lib/api.js";
import { installPreloadErrorRecovery } from "./lib/asset-urls.js";
import { isDevConfig, readWebConfig, refreshDevAuth } from "./lib/config.js";
import { installCspGuards } from "./lib/csp.js";
import { initLocale } from "./lib/locale.js";
import { m } from "./paraglide/messages.js";
import { createRouter } from "./router.js";

async function boot(): Promise<void> {
  // Before anything parses or renders: nonce for injected styles, no eval probe, TT policy.
  installCspGuards();
  // A stale tab after a deploy: reload once for the current chunks (E3.9).
  installPreloadErrorRecovery();
  let config = readWebConfig();
  if (isDevConfig(config)) config = await refreshDevAuth(config);
  configureApi(config.apiBase);
  // `<html lang>`/`dir` and every `m.*()` follow `lib/locale.ts` from here on (E2.8).
  initLocale();
  document.title = config.workspace?.name ?? config.instanceName;
  const queryClient = createQueryClient();
  const router = createRouter({ config, queryClient });
  const root = document.getElementById("root");
  if (!root) throw new Error("#root missing");
  createRoot(root).render(
    <StrictMode>
      <App config={config} queryClient={queryClient} router={router} />
    </StrictMode>,
  );
}

boot().catch((error: unknown) => {
  console.error(error);
  const root = document.getElementById("root");
  // The details are in the console; the reader gets one sentence in their own language.
  if (root) root.textContent = m.boot_failed();
});
