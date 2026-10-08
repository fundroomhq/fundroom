import {
  ApiError,
  createRoute,
  errorResponses,
  esign as es,
  jsonBody,
  jsonResponse,
  OkSchema,
  type OpenAPIHono,
  requestIdOf,
  sessionOrApiKeySecurity,
  sessionSecurity,
  z,
} from "@fundroom/contracts";
import {
  type ESignActor,
  type ESignConnectionDetail,
  type ESignEnvelopeView,
  isESignError,
} from "@fundroom/esign";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requireMember, requirePermission } from "../middleware/authz.js";
import { type ApiDeps, principalOf, workspaceUrl } from "./deps.js";

/*
 * E-signature (E3.5, ADR-0053) — kernel routes behind the `required` `esign` manifest. The service
 * is `@fundroom/esign` (`ESignKernel`, the same object modules see as `ModuleServices.esign`); it
 * opens its own short transactions and makes every vendor call outside them, so no handler here
 * holds a transaction across a service call that may reach the vendor.
 *
 * - Credentials are write-only (`credentialHints` only). An "ours" callback secret exists once,
 *   in the response that minted it (PUT connection, rotate-callback-secret).
 * - The envelope register reads (`GET /esign/envelopes[/{id}]`) are key-callable (`apiKey: true`);
 *   artifact downloads are not (bytes about named people stay behind a signed-in admin).
 * - The member routes mount `requireMember()` with **no** gate, like the compliance acceptance
 *   routes: an e-sign NDA ceremony is how a blocked member clears the NDA gate. A member only ever
 *   sees their own envelopes; another member's id is the same 404 an unknown id gets.
 * - `POST /esign/nda/start` is refused from the embed tree (403 `forbidden`, reason `embed_frame`):
 *   the investor web opens a first-party popup instead (ADR-0040 §11), and a vendor signing page
 *   must never be framed.
 * - The vendor callback (`POST /webhooks/esign/{connectionId}`) is an ops route outside `/api/v1`
 *   (no row in the matrix): `./esign-callback.ts`.
 *
 * Service errors (`ESignError`) carry an API error code and are adopted by the error handler as
 * they are: `esign_not_configured`, `esign_provider_error`, `esign_credentials_rejected`,
 * `envelope_not_open`, `envelopes_open`, `esign_consent_required`, `esign_ceremony_in_use`, …
 *
 * Every route carries `x-requires`, checked against packages/authz/matrix/authz-matrix.yaml in CI.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 422, 429, 500, 502, 503);
/**
 * `PUT /esign/connection` only: creating a connection (none live, or a driver switch) is turning
 * the `esign` feature on (A-3, ADR-0063) — 402 `plan_limit` when the plan leaves it out. Re-keying
 * the live connection is maintenance, as is everything else an existing connection does
 * (envelopes, callbacks, verify, rotating the callback secret, disconnecting): never refused.
 */
const GATED_ERRORS = errorResponses(400, 401, 402, 403, 404, 409, 422, 429, 500, 502, 503);
const TAGS = ["esign"];

const PdfResponse = (description: string) => ({
  description,
  content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } },
});

/**
 * Connection saves that MINT a connection id (first connect, driver switch, reconnect after a
 * disconnect) per workspace per hour (R3C). Each new id that authenticates a callback takes a slot in
 * the callback route's bounded recent-auth LRU, so without a cap one tenant could flush every other
 * tenant's pre-auth-ceiling bypass. Re-keying the same connection (same id) is not counted, nor is
 * a refused save.
 */
export const ESIGN_CONNECTION_MINT_LIMIT = { max: 10, windowMs: 60 * 60_000 } as const;

/** Manual syncs per workspace per minute (contract §5). */
export const ESIGN_SYNC_LIMIT = { max: 10, windowMs: 60_000 } as const;

/** The contract's `ESignEnvelope` (readonly subject copied). */
function envelopeBody(v: ESignEnvelopeView) {
  return {
    id: v.id,
    purpose: v.purpose,
    subject: { module: v.subject.module, kind: v.subject.kind, id: v.subject.id },
    status: v.status,
    signerStatus: v.signerStatus,
    signerName: v.signerName,
    signerEmail: v.signerEmail,
    membershipId: v.membershipId,
    title: v.title,
    driver: v.driver,
    sentAt: v.sentAt,
    completedAt: v.completedAt,
    hasSigned: v.hasSigned,
    hasCertificate: v.hasCertificate,
    vaultedDocumentId: v.vaultedDocumentId,
    errorCode: v.errorCode,
    createdAt: v.createdAt,
  };
}

/** The contract's `ESignConnection`: an explicit allow-list, so nothing else can ride along. */
function connectionBody(v: ESignConnectionDetail) {
  return {
    id: v.id,
    driver: v.driver,
    displayName: v.displayName,
    status: v.status,
    supports: { ...v.supports },
    callbackSecretKind: v.callbackSecretKind,
    baseUrlHost: v.baseUrlHost,
    callbackUrl: v.callbackUrl,
    credentialHints: { ...v.credentialHints },
    lastVerifiedAt: v.lastVerifiedAt,
    lastError: v.lastError,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  };
}

function actorOf(c: Context<AppEnv>): ESignActor {
  const p = principalOf(c);
  return {
    membershipId: p.membership.id,
    requestId: requestIdOf(c),
    ...(p.sessionId === undefined ? {} : { sessionId: p.sessionId }),
    ...(p.apiKeyId === undefined ? {} : { apiKeyId: p.apiKeyId }),
  };
}

function pdf(c: Context<AppEnv>, artifact: { bytes: Uint8Array; filename: string }): Response {
  // The filename is ours (`<title>-signed.pdf` sanitised by the service); quoted, and any quote or
  // control character stripped again here so a header can never be split.
  const filename = artifact.filename.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  return c.body(artifact.bytes as Uint8Array<ArrayBuffer>, 200, {
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": String(artifact.bytes.byteLength),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
}

function rateLimited(retryAfterMs: number, message: string): never {
  throw new ApiError(
    "rate_limited",
    message,
    { retryAfterMs },
    { headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) } },
  );
}

export function registerESignRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  const perm = (p: string, extra: { readonly fresh?: boolean; readonly apiKey?: boolean } = {}) =>
    requirePermission({ authz: () => deps.authz }, p, extra);
  const member = () => requireMember();
  const service = () => deps.esign;

  // --- connection (admin) ------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/esign/drivers",
      tags: TAGS,
      summary: "The e-sign vendors this instance offers",
      description:
        "Each driver's metadata (self-hostable, capabilities, sub-processor facts) and the credential fields its connection form asks for. Filtered by the operator's `ESIGN_DRIVERS`.",
      security: sessionSecurity,
      "x-requires": "esign.read",
      middleware: [perm("esign.read")] as const,
      responses: { 200: jsonResponse(es.ESignDriverListSchema, "Drivers"), ...ERRORS },
    }),
    async (c) => {
      const drivers = service()
        .drivers()
        .map((d) => ({
          meta: {
            ...d.meta,
            baseUrl: { ...d.meta.baseUrl },
            supports: { ...d.meta.supports },
            subProcessor: {
              ...d.meta.subProcessor,
              certifications: [...d.meta.subProcessor.certifications],
            },
          },
          credentialFields: d.credentialFields.map((f) => ({
            key: f.key,
            label: f.label,
            kind: f.kind,
            required: f.required,
            ...(f.options === undefined ? {} : { options: [...f.options] }),
            ...(f.help === undefined ? {} : { help: f.help }),
          })),
        }));
      return c.json({ drivers }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/esign/connection",
      tags: TAGS,
      summary: "The workspace's e-sign vendor connection",
      description:
        "Never a credential: `credentialHints` only. `connection: null` when none is configured. `callbackUrl` is what to paste into the vendor's webhook settings.",
      security: sessionSecurity,
      "x-requires": "esign.read",
      middleware: [perm("esign.read")] as const,
      responses: { 200: jsonResponse(es.ESignConnectionResponseSchema, "Connection"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const detail = await service().connectionDetail(tenant);
      return c.json({ connection: detail === undefined ? null : connectionBody(detail) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/esign/connection",
      tags: TAGS,
      summary: "Connect (or replace) the e-sign vendor",
      description:
        'The credentials are verified live against the vendor before anything is stored (422 `esign_credentials_rejected`). At most 10 saves an hour per workspace may create a new connection (first connect, driver switch, reconnect): past that, 429 `rate_limited` with `Retry-After` (re-keying the current connection is not counted). Replacing the connection with a different driver — or pointing the same driver at a different base URL — while envelopes are open (including `error` envelopes the vendor already holds) answers 409 `envelopes_open`. A same-driver save keeps blank secret fields, except when the base URL changes: then every stored secret must be re-entered (422 `esign_credentials_required`). `clearCredentials` forgets optional secrets. For vendors whose callback secret is ours, the response carries `callbackSecret` ONCE. 402 `plan_limit` (`feature: "esign"`) when the save would create a connection (none live, or a different driver) and the workspace\'s plan does not include e-signature; re-keying the live connection is always allowed. Needs a fresh session.',
      security: sessionSecurity,
      "x-requires": "esign.manage+fresh",
      middleware: [perm("esign.manage", { fresh: true })] as const,
      request: { body: jsonBody(es.ESignConnectionPutSchema) },
      responses: { 200: jsonResponse(es.ESignConnectionSavedSchema, "Saved"), ...GATED_ERRORS },
    }),
    async (c) => {
      const { tenant, workspace } = principalOf(c);
      const body = c.req.valid("json");
      const entitlements = deps.entitlements.of(workspace);
      // A save that will mint a new connection id must fit the hourly budget; it is charged only
      // once it has succeeded AND minted (a refused save or a same-id re-key costs nothing).
      const current = await service().connectionDetail(tenant);
      const mints = current === undefined || current.driver !== body.driver;
      const mintKey = `esign.connection-mint:${workspace.id}`;
      if (mints) {
        const peek = await deps.rateLimiter.peek(mintKey, ESIGN_CONNECTION_MINT_LIMIT);
        if (!peek.allowed) {
          rateLimited(peek.retryAfterMs, "too many new e-sign connections in this workspace");
        }
      }
      const saved = await service().saveConnection(
        tenant,
        {
          driver: body.driver,
          ...(body.baseUrl === undefined ? {} : { baseUrl: body.baseUrl }),
          credentials: body.credentials,
          ...(body.clearCredentials === undefined
            ? {}
            : { clearCredentials: body.clearCredentials }),
          // The service calls it only for a new connection or a driver switch (A-3).
          assertMayConnect: () => deps.entitlements.assertFeature(entitlements, "esign"),
        },
        actorOf(c),
      );
      if (saved.connection.id !== current?.id) {
        await deps.rateLimiter.hit(mintKey, ESIGN_CONNECTION_MINT_LIMIT);
      }
      return c.json(
        {
          connection: connectionBody(saved.connection),
          ...(saved.callbackSecret === undefined ? {} : { callbackSecret: saved.callbackSecret }),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/esign/connection/verify",
      tags: TAGS,
      summary: "Re-verify the vendor credentials",
      security: sessionSecurity,
      "x-requires": "esign.manage",
      middleware: [perm("esign.manage")] as const,
      responses: { 200: jsonResponse(es.ESignConnectionResponseSchema, "Connection"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const detail = await service().verifyConnection(tenant, actorOf(c));
      return c.json({ connection: connectionBody(detail) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/esign/connection/rotate-callback-secret",
      tags: TAGS,
      summary: "Mint a new callback secret",
      description:
        "Only for vendors whose callback secret is ours. The new secret is returned ONCE; the old one stops working immediately. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "esign.manage+fresh",
      middleware: [perm("esign.manage", { fresh: true })] as const,
      responses: {
        200: jsonResponse(es.ESignCallbackSecretResultSchema, "The new secret"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const rotated = await service().rotateCallbackSecret(tenant, actorOf(c));
      return c.json(
        { connection: connectionBody(rotated.connection), callbackSecret: rotated.callbackSecret },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/esign/connection",
      tags: TAGS,
      summary: "Disconnect the e-sign vendor",
      description:
        "409 `envelopes_open` while envelopes are open, 409 `esign_ceremony_in_use` while a live legal document uses the e-sign ceremony. Signed records are kept. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "esign.manage+fresh",
      middleware: [perm("esign.manage", { fresh: true })] as const,
      responses: { 200: jsonResponse(OkSchema, "Disconnected"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      await service().deleteConnection(tenant, actorOf(c));
      return c.json({ ok: true as const }, 200);
    },
  );

  // --- envelopes (admin) ---------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/esign/envelopes",
      tags: TAGS,
      summary: "The envelope register",
      description: "Newest first; keyset cursor. Filter by `status` and `purpose`.",
      security: sessionOrApiKeySecurity,
      "x-requires": "esign.read+apikey",
      middleware: [perm("esign.read", { apiKey: true })] as const,
      request: { query: es.ESignEnvelopeListQuery },
      responses: { 200: jsonResponse(es.ESignEnvelopePageSchema, "Envelopes"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const q = c.req.valid("query");
      const page = await service().listEnvelopes(tenant, {
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(q.purpose === undefined ? {} : { purpose: q.purpose }),
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        limit: q.limit ?? 50,
      });
      return c.json({ items: page.items.map(envelopeBody), nextCursor: page.nextCursor }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/esign/envelopes/{id}",
      tags: TAGS,
      summary: "One envelope",
      security: sessionOrApiKeySecurity,
      "x-requires": "esign.read+apikey",
      middleware: [perm("esign.read", { apiKey: true })] as const,
      request: { params: es.ESignEnvelopeIdParams },
      responses: { 200: jsonResponse(es.ESignEnvelopeSchema, "Envelope"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { id } = c.req.valid("param");
      const view = await deps.db.withTenant(tenant, (tx) => service().get(tx, tenant, id));
      if (view === undefined) throw new ApiError("not_found", "no such envelope");
      return c.json(envelopeBody(view), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/esign/envelopes/{id}/signed.pdf",
      tags: TAGS,
      summary: "Download the signed document",
      description:
        "`Content-Disposition: attachment`; audited (`esign.artifact_downloaded`). 404 until the envelope is completed and its artifacts collected.",
      security: sessionSecurity,
      "x-requires": "esign.read",
      middleware: [perm("esign.read")] as const,
      request: { params: es.ESignEnvelopeIdParams },
      responses: { 200: PdfResponse("The signed PDF"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { id } = c.req.valid("param");
      const artifact = await service().downloadArtifact(tenant, id, "signed", actorOf(c));
      if (artifact === undefined) throw new ApiError("not_found", "no signed document");
      return pdf(c, artifact) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/esign/envelopes/{id}/certificate.pdf",
      tags: TAGS,
      summary: "Download the vendor's signing certificate",
      description:
        "`Content-Disposition: attachment`; audited (`esign.artifact_downloaded`). 404 when the vendor issued none.",
      security: sessionSecurity,
      "x-requires": "esign.read",
      middleware: [perm("esign.read")] as const,
      request: { params: es.ESignEnvelopeIdParams },
      responses: { 200: PdfResponse("The certificate PDF"), ...ERRORS },
    }),
    async (c) => {
      const { tenant } = principalOf(c);
      const { id } = c.req.valid("param");
      const artifact = await service().downloadArtifact(tenant, id, "certificate", actorOf(c));
      if (artifact === undefined) throw new ApiError("not_found", "no certificate");
      return pdf(c, artifact) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/esign/envelopes/{id}/void",
      tags: TAGS,
      summary: "Void an open envelope",
      description: "409 `envelope_not_open` when it is already terminal. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "esign.manage+fresh",
      middleware: [perm("esign.manage", { fresh: true })] as const,
      request: { params: es.ESignEnvelopeIdParams, body: jsonBody(es.ESignVoidBody) },
      responses: { 200: jsonResponse(es.ESignEnvelopeSchema, "Envelope"), ...ERRORS },
    }),
    async (c) => {
      const { tenant, membership } = principalOf(c);
      const { id } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const view = await service().void(tenant, id, reason, membership.id);
      return c.json(envelopeBody(view), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/esign/envelopes/{id}/sync",
      tags: TAGS,
      summary: "Pull the envelope's status from the vendor now",
      description: "Enqueues a status sync. 10 per minute per workspace.",
      security: sessionSecurity,
      "x-requires": "esign.manage",
      middleware: [perm("esign.manage")] as const,
      request: { params: es.ESignEnvelopeIdParams },
      responses: { 202: jsonResponse(OkSchema, "Queued"), ...ERRORS },
    }),
    async (c) => {
      const { tenant, workspace } = principalOf(c);
      const { id } = c.req.valid("param");
      // Looked up first: an unknown (or another workspace's) id ends in 404 before it can spend
      // this workspace's budget.
      const known = await deps.db.withTenant(tenant, (tx) => service().get(tx, tenant, id));
      if (known === undefined) throw new ApiError("not_found", "no such envelope");
      const hit = await deps.rateLimiter.hit(`esign.sync:${workspace.id}`, ESIGN_SYNC_LIMIT);
      if (!hit.allowed) rateLimited(hit.retryAfterMs, "too many manual syncs in this workspace");
      await service().requestSync(tenant, id, actorOf(c));
      return c.json({ ok: true as const }, 202);
    },
  );

  // --- the member's own envelopes (gate-exempt) -----------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/esign/me/envelopes",
      tags: TAGS,
      summary: "My envelopes",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { query: es.ESignEnvelopeListQuery },
      responses: { 200: jsonResponse(es.ESignEnvelopePageSchema, "Envelopes"), ...ERRORS },
    }),
    async (c) => {
      const { tenant, membership } = principalOf(c);
      const q = c.req.valid("query");
      const page = await service().listEnvelopes(tenant, {
        membershipId: membership.id,
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(q.purpose === undefined ? {} : { purpose: q.purpose }),
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        limit: q.limit ?? 50,
      });
      return c.json({ items: page.items.map(envelopeBody), nextCursor: page.nextCursor }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/esign/me/envelopes/{id}/signed.pdf",
      tags: TAGS,
      summary: "Download my signed copy",
      description: "Own envelopes only; 404 otherwise.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: es.ESignEnvelopeIdParams },
      responses: { 200: PdfResponse("The signed PDF"), ...ERRORS },
    }),
    async (c) => {
      const { tenant, membership } = principalOf(c);
      const { id } = c.req.valid("param");
      const artifact = await service().downloadArtifact(tenant, id, "signed", actorOf(c), {
        ownMembershipId: membership.id,
      });
      // Another member's envelope, an unknown id and a not-yet-collected one are one answer.
      if (artifact === undefined) throw new ApiError("not_found", "no signed document");
      return pdf(c, artifact) as never;
    },
  );

  // --- the e-sign NDA ceremony (gate-exempt) ----------------------------------------------------------
  api.openapi(
    createRoute({
      method: "post",
      path: "/esign/nda/start",
      tags: TAGS,
      summary: "Start (or resume) signing an NDA electronically",
      description:
        'For a legal document whose ceremony is `esign` and whose kind is `nda` (409 `conflict` `{reason: "not_nda_document"}`), that the caller still owes — portal-wide or named by a live `nda` access gate they have not satisfied (409 `conflict` `{reason: "not_pending"}`). Needs the ESIGN consent to electronic records (422 `esign_consent_required`). A title or text the signing PDF cannot show unchanged is refused (422 `esign_nda_text_unsupported`). At most 5 new envelopes per member per 24 h (429 `rate_limited` with `Retry-After`; resuming an open one does not count). Idempotent: an open envelope for the same document version is returned; while a concurrent start is still creating it, 409 `conflict` `{reason: "envelope_creating"}` (retry). `signingUrl` must be opened top-level; `null` means the vendor emails the link. Not callable from an embed frame.',
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { body: jsonBody(es.ESignNdaStartBodySchema) },
      responses: { 200: jsonResponse(es.ESignNdaStartResultSchema, "Envelope"), ...ERRORS },
    }),
    async (c) => {
      if (c.get("embed") === true) {
        throw new ApiError("forbidden", "open the signing page outside the frame", {
          reason: "embed_frame",
        });
      }
      const { tenant, membership, workspace } = principalOf(c);
      const body = c.req.valid("json");
      const returnUrl = workspaceUrl(deps.baseUrl, deps.tenancy, workspace, "/sign", deps.basePath);
      returnUrl.searchParams.set("documentId", body.documentId);
      const started = await service()
        .startNda(
          tenant,
          {
            membershipId: membership.id,
            documentId: body.documentId,
            consentToElectronicRecords: body.consentToElectronicRecords,
            disclosureVersion: body.disclosureVersion,
            returnUrl: returnUrl.href,
          },
          actorOf(c),
        )
        .catch((error: unknown) => {
          // The per-member start budget (E3.5 fix A7): say when to come back.
          if (isESignError(error) && error.code === "rate_limited") {
            const seconds = Number(error.details["retryAfterSeconds"]);
            throw new ApiError("rate_limited", error.message, error.details, {
              headers: {
                "Retry-After": String(
                  Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 3600,
                ),
              },
            });
          }
          throw error;
        });
      return c.json(
        { envelope: envelopeBody(started.envelope), signingUrl: started.signingUrl },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/esign/nda/status",
      tags: TAGS,
      summary: "Where my e-sign NDA stands",
      description:
        "`completed` once the acceptance is recorded; `superseded` when a newer version was published mid-flight; `failed` when the envelope was signed but its signed copy could not be collected — the gate stays closed and a fresh `POST /esign/nda/start` is allowed.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { query: es.ESignNdaStatusQuery },
      responses: { 200: jsonResponse(es.ESignNdaStatusSchema, "Status"), ...ERRORS },
    }),
    async (c) => {
      const { tenant, membership } = principalOf(c);
      const { documentId } = c.req.valid("query");
      const status = await service().ndaStatus(tenant, membership.id, documentId);
      return c.json({ status: status.status, envelopeId: status.envelopeId }, 200);
    },
  );
}
