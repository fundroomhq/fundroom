import {
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  sessionOrApiKeySecurity,
  sessionSecurity,
} from "@fundroom/contracts";
import type { ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import type { ClosingChecklist } from "./closing/rules.js";
import * as s from "./contracts.js";
import { refuseNarrowDelegate } from "./delegation.js";
import type { SignatureRequestRecord } from "./repos/closing-repo.js";
import {
  actorOf,
  commitmentBody,
  iso,
  PERM_MANAGE,
  PERM_READ,
  rethrow,
  signed,
  taskBody,
} from "./routes.js";
import { type ClosingService, createClosingService } from "./service/closing.js";

/*
 * The closing workflow's routes (E3.5 §6, ADR-0053), under `/api/v1/round/*`.
 *
 *  - `POST /commitments/{id}/signature-request` and `POST /signature-requests/{id}/void` are
 *    `round.manage` + step-up: they send a legal document to a person through a third party.
 *  - `POST /commitments/{id}/confirm` is `round.manage` + step-up: it tells an investor, by
 *    email, that the company has their money.
 *  - `GET /rounds/{id}/closing` is `round.read`, key-callable (a cap-table integration reads it).
 *  - `GET /current/closing` is `member`: the investor's own commitments to the round they are
 *    shown. A delegate with scope `all` sees their principal's card read-only; a narrower
 *    delegate gets the 404 a missing round gets (like every `/current*` read).
 *
 * Handlers only shape responses; `service/closing.ts` decides.
 */
// 502 (`esign_provider_error`, passed through from the kernel) has no shared response
// description in `errorResponses`, so it is documented in the send route's prose instead.
const ERRORS = errorResponses(400, 401, 403, 404, 409, 422, 429, 500, 503);
const TAGS = ["round"];

const signatureRequestBody = (r: SignatureRequestRecord) => ({
  id: r.id,
  roundId: r.roundId,
  commitmentId: r.commitmentId,
  envelopeId: r.envelopeId,
  status: r.status,
  templateRef: r.templateRef,
  sentAt: r.sentAt.toISOString(),
  completedAt: iso(r.completedAt),
  terminalAt: iso(r.terminalAt),
  signedDocumentId: r.signedDocumentId,
});

const checklistBody = (c: ClosingChecklist) => ({
  documentsSent: c.documentsSent,
  documentsSentAt: iso(c.documentsSentAt),
  signed: c.signed,
  signedAt: iso(c.signedAt),
  wired: c.wired,
  wiredAt: iso(c.wiredAt),
  confirmed: c.confirmed,
  confirmedAt: iso(c.confirmedAt),
  stage: c.stage,
});

export function registerRoundClosingRoutes(api: ModuleRouter, services: ModuleServices): void {
  let closing: ClosingService | undefined;
  const svc = () => (closing ??= createClosingService(services));
  const perm = (p: string, fresh = false) => services.guards.requirePermission(p, { fresh });
  const keyPerm = (p: string) => services.guards.requirePermission(p, { apiKey: true });
  const member = () => services.guards.requireMember();

  api.openapi(
    createRoute({
      method: "post",
      path: "/commitments/{id}/signature-request",
      tags: TAGS,
      summary: "Send a commitment's subscription agreement for e-signature",
      description:
        "Generates the agreement from the workspace's vendor template (`round.closing.subscriptionTemplateRef`), prefilled per `round.closing.prefill` from the commitment, the round's current terms and the workspace, addressed to the template role `round.closing.templateRole`, and sends it through the connected e-sign vendor, which emails the signing link. The signer is the commitment's member; for a commitment naming no member, `signer` must be given (else 422 `signer_email_missing`). Refused (409, `details.reason`) for a planning round (`round_not_open`), a commitment that is not soft or verbal (`commitment_not_signable`), no template set (`subscription_template_missing`) and while another request is open or an earlier request in `error` still has a live envelope at the vendor (`signature_request_open` — void it first); 409 `esign_not_configured` without a connection, 422 `esign_template_unsupported` when the vendor cannot use templates, 502 `esign_provider_error` when the vendor refuses. Exactly one of two concurrent requests reaches the vendor.",
      security: sessionSecurity,
      "x-requires": `${PERM_MANAGE}+fresh`,
      middleware: [perm(PERM_MANAGE, true)] as const,
      request: { params: s.RoundIdParams, body: jsonBody(s.RoundSignatureRequestBody) },
      responses: {
        201: jsonResponse(s.RoundSignatureRequestSchema, "The signature request"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const result = await svc().send(sg.tenant, {
          commitmentId: c.req.valid("param").id,
          ...(body.message === undefined ? {} : { message: body.message }),
          ...(body.signer === undefined ? {} : { signer: body.signer }),
          companyName: sg.workspace.name,
          actor: actorOf(c, sg),
        });
        return c.json(signatureRequestBody(result.request), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/signature-requests/{id}/void",
      tags: TAGS,
      summary: "Void a signature request",
      description:
        "Voids the envelope at the vendor and mirrors it. A request in `error` whose envelope reached the vendor may still be live there and is voidable too. 409 `envelope_not_open` once it is completed, declined, voided or expired, or failed before reaching the vendor; 409 `signature_request_pending` while its envelope is still being created.",
      security: sessionSecurity,
      "x-requires": `${PERM_MANAGE}+fresh`,
      middleware: [perm(PERM_MANAGE, true)] as const,
      request: { params: s.RoundIdParams, body: jsonBody(s.RoundSignatureVoidBody) },
      responses: {
        200: jsonResponse(s.RoundSignatureRequestSchema, "The signature request"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const voided = await svc().void(
          sg.tenant,
          c.req.valid("param").id,
          body.reason ?? "Voided by the company",
          actorOf(c, sg),
        );
        return c.json(signatureRequestBody(voided), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/commitments/{id}/confirm",
      tags: TAGS,
      summary: "Confirm a wired commitment",
      description:
        "The company received and reconciled the money. Only a `wired` commitment (409 `commitment_not_wired`); idempotent — a second call returns the first confirmation and sends nothing. Publishes `round.commitment_confirmed`, which emails the investor when the commitment names a member.",
      security: sessionSecurity,
      "x-requires": `${PERM_MANAGE}+fresh`,
      middleware: [perm(PERM_MANAGE, true)] as const,
      request: { params: s.RoundIdParams },
      responses: { 200: jsonResponse(s.RoundCommitmentSchema, "The commitment"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const confirmed = await svc().confirm(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json(commitmentBody(confirmed.commitment, confirmed.currency), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/rounds/{id}/closing",
      tags: TAGS,
      summary: "A round's closing checklist",
      description:
        "Per commitment: documents sent, signed, wired, confirmed (with timestamps) and the latest signature request; `summary` counts and sums the commitments per stage. Derived from stored facts, never stored itself. The manual closing tasks come alongside.",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_READ}+apikey`,
      middleware: [keyPerm(PERM_READ)] as const,
      request: { params: s.RoundIdParams },
      responses: { 200: jsonResponse(s.RoundClosingSchema, "The closing checklist"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const view = await svc().roundClosing(sg.tenant, c.req.valid("param").id);
        const currency = view.round.currency;
        return c.json(
          {
            roundId: view.round.id,
            currency,
            summary: { currency, ...view.summary },
            commitments: view.rows.map((r) => ({
              commitmentId: r.commitment.id,
              investor: {
                membershipId: r.commitment.membershipId,
                contactId: r.commitment.contactId,
                organizationId: r.commitment.organizationId,
                name: r.investorName,
              },
              amount: r.commitment.amount,
              currency,
              status: r.commitment.status,
              checklist: checklistBody(r.checklist),
              signatureRequest: r.latest === undefined ? null : signatureRequestBody(r.latest),
              signedDocumentId: r.commitment.signedDocumentId,
            })),
            tasks: view.tasks.map(taskBody),
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/current/closing",
      tags: TAGS,
      summary: "The investor's own closing checklist",
      description:
        "The member's own commitments to the round `/round/current` shows, with each one's checklist and signature-request status. `canSign` means an agreement is waiting in their mailbox (the vendor emails the link); `signedDocumentAvailable` means `/esign/me/envelopes/{envelopeId}/signed.pdf` will serve them the signed copy. A delegate with scope `all` sees their principal's card with `readOnly: true` (never `canSign`, never a download); a narrower delegate gets 404.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      responses: {
        200: jsonResponse(s.InvestorRoundClosingSchema, "The closing checklist"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const sg = signed(c);
      refuseNarrowDelegate(sg.membership);
      const view = await svc().investorClosing(sg.tenant, sg.membership);
      return c.json(
        {
          round:
            view.round === undefined
              ? null
              : {
                  id: view.round.id,
                  name: view.round.name,
                  status: view.round.status,
                  currency: view.round.currency,
                },
          commitments: view.rows.map((r) => ({
            commitmentId: r.commitment.id,
            amount: r.commitment.amount,
            currency: view.round?.currency ?? "USD",
            status: r.commitment.status,
            checklist: checklistBody(r.checklist),
            signatureRequest:
              r.latest === undefined
                ? null
                : {
                    id: r.latest.id,
                    status: r.latest.status,
                    sentAt: r.latest.sentAt.toISOString(),
                    completedAt: iso(r.latest.completedAt),
                  },
            canSign: r.canSign,
            signedDocumentAvailable: r.signedDocumentAvailable,
            envelopeId: r.signedDocumentAvailable ? (r.latest?.envelopeId ?? null) : null,
          })),
          readOnly: view.readOnly,
        },
        200,
      );
    },
  );
}
