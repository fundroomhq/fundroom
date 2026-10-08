/*
 * Container HEALTHCHECK (design/07 §1.1). The runtime image is distroless (no shell, no
 * curl), so liveness is a Node one-liner: GET /healthz on the configured port, exit 0 on 200.
 * `serve` answers 503 while draining, which Compose then reports as unhealthy on purpose.
 */
const port = process.env["PORT"] ?? "3000";
const basePath = process.env["BASE_PATH"] ?? "";
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 4000);
fetch(`http://127.0.0.1:${port}${basePath}/healthz`, { signal: controller.signal }).then(
  (res) => {
    clearTimeout(timer);
    process.exit(res.status === 200 ? 0 : 1);
  },
  () => {
    clearTimeout(timer);
    process.exit(1);
  },
);
