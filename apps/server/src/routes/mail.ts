import {
  ApiError,
  createRoute,
  errorResponses,
  jsonResponse,
  mail as m,
  OkSchema,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import type { ApiDeps } from "./deps.js";
import { mailWebhookUrl } from "./mail-webhook.js";

/*
 * Mail delivery feedback, the admin half (E2.6): which driver sends this install's mail, where its
 * webhook must point, and the workspace's suppression list.
 *
 * Kernel routes, and guarded by the kernel permission `access.settings` (owner/admin) rather than
 * a new one: the suppression list decides whether investors receive the company's mail at all,
 * which is the same class of workspace-wide decision as the access settings, and it lists (masked)
 * people. Removing an entry needs a fresh session — it re-opens mail to an address that bounced
 * hard or complained, and a complaint is the one signal a mailbox provider punishes a sender for
 * ignoring.
 *
 * Every route carries `x-requires`, checked against packages/authz/matrix/authz-matrix.yaml in CI.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 429, 500);
const TAGS = ["mail"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function signed(c: Context<AppEnv>) {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  if (!session || !membership || !tenant) throw new ApiError("unauthenticated");
  return { membership, tenant };
}

function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): { id: string } | undefined {
  if (cursor === undefined) return undefined;
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!UUID_RE.test(id)) throw new ApiError("invalid_request", "invalid cursor");
  return { id: id.toLowerCase() };
}

export function registerMailRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  const perm = (p: string, extra: { readonly fresh?: boolean } = {}) =>
    requirePermission({ authz: () => deps.authz }, p, extra);

  api.openapi(
    createRoute({
      method: "get",
      path: "/mail/status",
      tags: TAGS,
      summary: "The mail driver, what it can do, and the webhook URL to configure at the provider",
      description:
        "`webhookUrl` is where the provider must POST delivery events (bounces, complaints and — in the `engagement` analytics mode, for members whose consent allows it — opens and clicks). It is `null` for a driver without webhooks. The URL is the same for every workspace: events are routed back by the provider's message id.",
      security: sessionSecurity,
      "x-requires": "access.settings",
      middleware: [perm("access.settings")] as const,
      responses: { 200: jsonResponse(m.MailStatusSchema, "Status"), ...ERRORS },
    }),
    async (c) => {
      signed(c);
      const mailer = deps.mailer;
      const webhooks = mailer.capabilities?.webhooks ?? mailer.parseWebhook !== undefined;
      return c.json(
        {
          driver: mailer.driver,
          capabilities: {
            perMessageTracking: mailer.capabilities?.perMessageTracking ?? false,
            webhooks,
          },
          webhookUrl: webhooks ? mailWebhookUrl(deps.baseUrl, mailer.driver) : null,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/mail/suppressions",
      tags: TAGS,
      summary: "Addresses this workspace no longer sends updates or notifications to",
      description:
        "Hard bounces and spam complaints reported by the provider add an entry; soft bounces and delays never do. Sign-in and invitation mail is never suppressed. Addresses are shown masked: the list is keyed by a keyed hash and the address itself is not stored. Newest first.",
      security: sessionSecurity,
      "x-requires": "access.settings",
      middleware: [perm("access.settings")] as const,
      request: { query: m.MailSuppressionListQuery },
      responses: { 200: jsonResponse(m.MailSuppressionPageSchema, "Suppressions"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const query = c.req.valid("query");
      const result = await deps.mailFeedback.listSuppressions(s.tenant, {
        limit: query.limit,
        after: decodeCursor(query.cursor),
      });
      return c.json(
        {
          items: result.items.map((item) => ({
            id: item.id,
            address: item.address,
            reason: item.reason,
            messageRef: item.messageRef,
            createdAt: item.createdAt.toISOString(),
          })),
          nextCursor: result.next === undefined ? null : encodeCursor(result.next.id),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/mail/suppressions/{id}",
      tags: TAGS,
      summary: "Remove an address from the suppression list",
      description:
        "Re-opens update and notification mail to the address. Audited as `mail.unsuppressed`. If the provider reports another hard bounce or complaint, the address is suppressed again.",
      security: sessionSecurity,
      "x-requires": "access.settings+fresh",
      middleware: [perm("access.settings", { fresh: true })] as const,
      request: { params: m.MailSuppressionIdParam },
      responses: { 200: jsonResponse(OkSchema, "Removed"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const removed = await deps.mailFeedback.unsuppress(s.tenant, c.req.valid("param").id, {
        membershipId: s.membership.id,
        requestId: requestIdOf(c),
      });
      if (!removed) throw new ApiError("not_found", "no such suppression");
      return c.json({ ok: true as const }, 200);
    },
  );
}
