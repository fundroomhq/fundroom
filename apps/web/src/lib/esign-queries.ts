import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { api, call, describeError, isApiError } from "./api.js";
import { saveBlob } from "./certificates.js";

/*
 * E-signature (E3.5, ADR-0053). Kernel routes behind `esign.read` / `esign.manage`; saving,
 * rotating, disconnecting and voiding also need a fresh session, which `useGuardedMutation`
 * turns into a step-up and back.
 *
 * Credentials are write-only: the connection answers with masked `credentialHints`, never a
 * value. The callback secret of an "ours" vendor is on the wire exactly once — in the PUT or
 * rotate response that minted it — so, like an API key's token, it lives in component state only.
 */
export type ESignDriverInfo = FundRoomSchemas["ESignDriverInfo"];
export type ESignDriver = ESignDriverInfo["meta"]["driver"];
export type ESignCredentialField = ESignDriverInfo["credentialFields"][number];
export type ESignConnection = FundRoomSchemas["ESignConnection"];
export type ESignEnvelope = FundRoomSchemas["ESignEnvelope"];
export type ESignEnvelopePage = FundRoomSchemas["ESignEnvelopePage"];
export type ESignEnvelopeStatus = ESignEnvelope["status"];
export type ESignSignerStatus = NonNullable<ESignEnvelope["signerStatus"]>;
export type ESignPurpose = ESignEnvelope["purpose"];

export const ESIGN_KEY = ["esign"] as const;

export const esignDriversQuery = queryOptions({
  queryKey: [...ESIGN_KEY, "drivers"],
  queryFn: () => call(api().GET("/esign/drivers")),
  staleTime: 5 * 60_000,
});

export const esignConnectionQuery = queryOptions({
  queryKey: [...ESIGN_KEY, "connection"],
  queryFn: () => call(api().GET("/esign/connection")),
});

export const ENVELOPE_TABS = [
  "all",
  "sent",
  "delivered",
  "completed",
  "declined",
  "voided",
  "expired",
  "error",
] as const;
export type EnvelopeTab = (typeof ENVELOPE_TABS)[number];

export const ESIGN_PURPOSES = ["nda", "round_closing"] as const;

/** Newest first, keyset-paged on (created_at, id); the cursor is opaque. */
export function esignEnvelopesQuery(
  tab: EnvelopeTab,
  purpose: ESignPurpose | undefined,
  limit = 50,
) {
  return infiniteQueryOptions({
    queryKey: [...ESIGN_KEY, "envelopes", tab, purpose ?? null, limit],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/esign/envelopes", {
          params: {
            query: {
              limit,
              ...(tab === "all" ? {} : { status: tab }),
              ...(purpose === undefined ? {} : { purpose }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last: ESignEnvelopePage) => last.nextCursor ?? undefined,
  });
}

export function esignEnvelopeQuery(id: string) {
  return queryOptions({
    queryKey: [...ESIGN_KEY, "envelope", id],
    queryFn: () => call(api().GET("/esign/envelopes/{id}", { params: { path: { id } } })),
  });
}

/** Statuses a vendor can still move; `draft` is ours (the vendor has not answered yet). */
export const OPEN_ENVELOPE_STATUSES: readonly ESignEnvelopeStatus[] = [
  "draft",
  "sent",
  "delivered",
];

export function isOpenEnvelope(status: ESignEnvelopeStatus): boolean {
  return OPEN_ENVELOPE_STATUSES.includes(status);
}

/**
 * The vendor may still move this envelope, so void and "check status now" apply. Besides the
 * open statuses that includes an `error` row the vendor accepted: `error` is not final (the sync
 * keeps pulling and a later pull recovers it) and the envelope may still be live at the vendor.
 * The view carries no provider ref; `sentAt` is written in the same update that stores it, so a
 * sent-at on an `error` row means the vendor has the envelope. An `error` row that never reached
 * the vendor (`orphaned_draft`, a failed create) has nothing to void or pull.
 */
export function isLiveAtVendor(envelope: Pick<ESignEnvelope, "status" | "sentAt">): boolean {
  return (
    isOpenEnvelope(envelope.status) || (envelope.status === "error" && envelope.sentAt !== null)
  );
}

/**
 * "Check status now" applies to an envelope the vendor may still move, and to a completed one
 * whose signed copy is not collected yet (the server re-queues the collection) — except an
 * artifact that failed the malware scan, which the server never collects again.
 */
export function canResync(
  envelope: Pick<ESignEnvelope, "status" | "sentAt" | "hasSigned" | "errorCode">,
): boolean {
  if (isLiveAtVendor(envelope)) return true;
  return (
    envelope.status === "completed" &&
    !envelope.hasSigned &&
    envelope.errorCode !== "artifact_infected"
  );
}

/**
 * Signed PDF or certificate. Bytes, not JSON, fetched through the SDK so a refusal is seen and
 * a cross-origin API still carries the session (see `lib/certificates.ts` for why not a link).
 */
export async function downloadEnvelopeArtifact(
  envelope: Pick<ESignEnvelope, "id" | "title">,
  which: "signed" | "certificate",
): Promise<void> {
  const params = { params: { path: { id: envelope.id } }, parseAs: "blob" as const };
  const blob = await call(
    which === "signed"
      ? api().GET("/esign/envelopes/{id}/signed.pdf", params)
      : api().GET("/esign/envelopes/{id}/certificate.pdf", params),
  );
  saveBlob(blob, artifactFilename(envelope.title, which));
}

export function artifactFilename(title: string, which: "signed" | "certificate"): string {
  const safe = title
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase()
    .slice(0, 80);
  return `${safe === "" ? "envelope" : safe}-${which}.pdf`;
}

// --- labels -----------------------------------------------------------------------------------

export function envelopeStatusLabel(status: ESignEnvelopeStatus): string {
  switch (status) {
    case "draft":
      return m.esign_status_draft();
    case "sent":
      return m.esign_status_sent();
    case "delivered":
      return m.esign_status_delivered();
    case "completed":
      return m.esign_status_completed();
    case "declined":
      return m.esign_status_declined();
    case "voided":
      return m.esign_status_voided();
    case "expired":
      return m.esign_status_expired();
    case "error":
      return m.esign_status_error();
  }
}

export function envelopeStatusVariant(
  status: ESignEnvelopeStatus,
): "success" | "secondary" | "outline" | "destructive" {
  switch (status) {
    case "completed":
      return "success";
    case "declined":
    case "error":
      return "destructive";
    case "voided":
    case "expired":
      return "secondary";
    default:
      return "outline";
  }
}

export function envelopeTabLabel(tab: EnvelopeTab): string {
  return tab === "all" ? m.esign_tab_all() : envelopeStatusLabel(tab);
}

export function signerStatusLabel(status: ESignSignerStatus): string {
  switch (status) {
    case "pending":
      return m.esign_signer_pending();
    case "viewed":
      return m.esign_signer_viewed();
    case "signed":
      return m.esign_signer_signed();
    case "declined":
      return m.esign_signer_declined();
  }
}

export function purposeLabel(purpose: ESignPurpose): string {
  return purpose === "nda" ? m.esign_purpose_nda() : m.esign_purpose_round_closing();
}

/**
 * `error_code` on an envelope row: ours (`artifact_*` collection failures, `orphaned_draft`,
 * `vendor_not_found`) or the vendor error class.
 */
export function envelopeErrorLabel(code: string): string {
  switch (code) {
    case "artifact_infected":
      return m.esign_envelope_error_infected();
    case "artifact_too_large":
      return m.esign_envelope_error_too_large();
    case "artifact_not_pdf":
      return m.esign_envelope_error_not_pdf();
    case "orphaned_draft":
      return m.esign_envelope_error_orphaned_draft();
    case "unauthorized":
      return m.esign_envelope_error_unauthorized();
    case "not_found":
    case "vendor_not_found":
      return m.esign_envelope_error_not_found();
    case "rejected":
      return m.esign_envelope_error_rejected();
    case "rate_limited":
    case "unavailable":
      return m.esign_envelope_error_unavailable();
    case "too_large":
      return m.esign_envelope_error_too_large();
    default:
      return code.startsWith("artifact_")
        ? m.esign_envelope_error_collect_failed()
        : m.esign_envelope_error_other();
  }
}

/**
 * The credential field's label in the reader's language. Keys are `esign.field.<driver>.<key>`
 * in the contract; the catalogue spells them `esign_field_<driver>_<key>` in snake case. A field
 * the SPA has no copy for (a newer server) falls back to the adapter's English label.
 */
export function credentialFieldLabel(driver: ESignDriver, field: ESignCredentialField): string {
  switch (`${driver}.${field.key}`) {
    case "documenso.apiToken":
      return m.esign_field_documenso_api_token();
    case "docuseal.apiToken":
      return m.esign_field_docuseal_api_token();
    case "docusign.environment":
      return m.esign_field_docusign_environment();
    case "docusign.integrationKey":
      return m.esign_field_docusign_integration_key();
    case "docusign.userId":
      return m.esign_field_docusign_user_id();
    case "docusign.privateKeyPem":
      return m.esign_field_docusign_private_key_pem();
    case "docusign.accountId":
      return m.esign_field_docusign_account_id();
    case "docusign.connectHmacKey":
      return m.esign_field_docusign_connect_hmac_key();
    case "docusign.connectHmacKeySecondary":
      return m.esign_field_docusign_connect_hmac_key_secondary();
    case "dropbox-sign.apiKey":
      return m.esign_field_dropbox_sign_api_key();
    case "dropbox-sign.testMode":
      return m.esign_field_dropbox_sign_test_mode();
    default:
      return field.label;
  }
}

/** Help text under a credential field, when we have better copy than the adapter's. */
export function credentialFieldHelp(
  driver: ESignDriver,
  field: ESignCredentialField,
): string | undefined {
  switch (`${driver}.${field.key}`) {
    case "documenso.apiToken":
      return m.esign_field_documenso_api_token_help();
    case "docuseal.apiToken":
      return m.esign_field_docuseal_api_token_help();
    case "docusign.privateKeyPem":
      return m.esign_field_docusign_private_key_pem_help();
    case "docusign.accountId":
      return m.esign_field_docusign_account_id_help();
    case "docusign.connectHmacKey":
      return m.esign_field_docusign_connect_hmac_key_help();
    case "docusign.connectHmacKeySecondary":
      return m.esign_field_docusign_connect_hmac_key_secondary_help();
    case "dropbox-sign.testMode":
      return m.esign_field_dropbox_sign_test_mode_help();
    default:
      return field.help;
  }
}

/** A select option's label (`demo`/`production`, `test`/`live`); unknown ones print as given. */
export function credentialOptionLabel(option: string): string {
  switch (option) {
    case "demo":
      return m.esign_option_demo();
    case "production":
      return m.esign_option_production();
    case "test":
      return m.esign_option_test();
    case "live":
      return m.esign_option_live();
    default:
      return option;
  }
}

// --- errors -----------------------------------------------------------------------------------

function detailOf(error: unknown, key: string): string | undefined {
  if (!isApiError(error)) return undefined;
  const flat = error.body.error[key];
  if (typeof flat === "string") return flat;
  // Flattened in practice (`error.reason`); tolerate a nested `details` too.
  const nested = (error.body.error["details"] as Record<string, unknown> | undefined)?.[key];
  return typeof nested === "string" ? nested : undefined;
}

export function esignErrorCode(error: unknown): string | undefined {
  return isApiError(error) ? error.code : undefined;
}

/** One sentence per refusal the e-sign routes give; anything else falls back to the generic copy. */
export function describeESignError(error: unknown): string {
  switch (esignErrorCode(error)) {
    case "esign_credentials_rejected":
      switch (detailOf(error, "reason")) {
        case "unauthorized":
          return m.esign_error_rejected_unauthorized();
        case "unreachable":
          return m.esign_error_rejected_unreachable();
        default:
          return m.esign_error_rejected_misconfigured();
      }
    case "envelopes_open":
      return m.esign_error_envelopes_open();
    case "esign_ceremony_in_use":
      return m.esign_error_ceremony_in_use();
    case "esign_not_configured":
      return m.esign_error_not_configured();
    case "esign_template_unsupported":
      return m.esign_error_template_unsupported();
    case "esign_provider_error":
      return m.esign_error_provider();
    case "envelope_not_open":
      return m.esign_error_envelope_not_open();
    case "esign_credentials_required":
      return m.esign_error_credentials_required();
    default:
      return describeError(error).body;
  }
}

/**
 * The secret fields a save must type again: 422 `esign_credentials_required` (reason
 * `base_url_changed`) — the address changed, and stored secrets are never sent to a new host.
 * `undefined` for any other error.
 */
export function retypeFields(error: unknown): readonly string[] | undefined {
  if (!isApiError(error) || esignErrorCode(error) !== "esign_credentials_required") {
    return undefined;
  }
  const flat = error.body.error["fields"];
  const nested = (error.body.error["details"] as Record<string, unknown> | undefined)?.["fields"];
  const fields = Array.isArray(flat) ? flat : Array.isArray(nested) ? nested : [];
  return fields.filter((f): f is string => typeof f === "string");
}

/** The vendor's own words about a rejected credential, when the server passed them on. */
export function rejectedDetail(error: unknown): string | undefined {
  return esignErrorCode(error) === "esign_credentials_rejected"
    ? detailOf(error, "detail")
    : undefined;
}

/**
 * Why the server refused an e-signature ceremony on a legal document, in words, or `undefined`
 * for anything else: no vendor connected (409 `esign_not_configured`), a document that is not
 * an NDA (422 `esign_ceremony_unsupported`), or text the signing PDF cannot print faithfully
 * (422 `esign_nda_text_unsupported`, naming up to ten of the characters).
 */
export function ceremonyRefusal(error: unknown): string | undefined {
  switch (esignErrorCode(error)) {
    case "esign_not_configured":
      return m.legal_ceremony_not_configured();
    case "esign_ceremony_unsupported":
      return m.legal_ceremony_not_nda();
    case "esign_nda_text_unsupported": {
      const flat = isApiError(error) ? error.body.error["characters"] : undefined;
      const chars = Array.isArray(flat) ? flat.filter((c) => typeof c === "string") : [];
      const where =
        detailOf(error, "field") === "title"
          ? m.legal_ceremony_in_title()
          : m.legal_ceremony_in_body();
      return chars.length === 0
        ? m.legal_ceremony_text_unsupported({ where })
        : m.legal_ceremony_text_unsupported_chars({ where, characters: chars.join(" ") });
    }
    default:
      return undefined;
  }
}
