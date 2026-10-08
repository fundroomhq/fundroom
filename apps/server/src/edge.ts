import { truncateIp } from "@fundroom/audit";
import { edgeForwarding, type ProxyTrust } from "@fundroom/http";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./env.js";
import type { Log } from "./logger.js";
import { redactPath } from "./middleware/request-log.js";
import { countSecurityEvent } from "./middleware/security-events.js";
import { clientIp, edgeForwardingOptionsOf } from "./routes/deps.js";

/**
 * The edge-forwarding middleware as the app registers it (E-UP-7, ADR-0064), or undefined when
 * edge forwarding is not configured (then nothing ever reads the forwarded headers).
 *
 * A refusal (wrong secret, missing/invalid forwarded host) is attributable without carrying
 * anything the request said about itself: the log line has the method, the path redacted as the
 * access log redacts it (`redactPath`: no query string, token segments replaced) and the
 * client address the ORDINARY derivation gives — nothing is edge-forwarded on a refused request,
 * so `clientIp` answers the address the trusted proxy chain (or the socket) vouches for —
 * truncated like the audit log's (/24, /48; design/07 §5 keeps full addresses out of logs).
 * Each refusal also counts once in `fundroom.security.events{event="edge_refused", code, reason}`.
 */
export function edgeForwardingMiddleware(
  raw: Parameters<typeof edgeForwardingOptionsOf>[0],
  log: Log,
  proxyTrust: false | ProxyTrust,
): MiddlewareHandler<AppEnv> | undefined {
  const options = edgeForwardingOptionsOf(raw);
  if (options === undefined) return undefined;
  return edgeForwarding({
    ...options,
    log,
    attribution: (c) => {
      const ip = clientIp(c as Context<AppEnv>, proxyTrust);
      return {
        path: redactPath(c.req.path),
        clientNetwork: ip === undefined ? undefined : truncateIp(ip),
      };
    },
    onRefused: (code, reason) => countSecurityEvent("edge_refused", code, reason),
  }) as unknown as MiddlewareHandler<AppEnv>;
}
