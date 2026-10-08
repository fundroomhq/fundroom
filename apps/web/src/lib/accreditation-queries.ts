import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { api, call, describeError, isApiError } from "./api.js";

/*
 * Accreditation vendor connections (E3.7, ADR-0055). Kernel routes behind `accreditation.read`
 * / `accreditation.manage`; saving, re-verifying and disconnecting also need a fresh session,
 * which `useGuardedMutation` turns into a step-up and back.
 *
 * Credentials are write-only: the connection answers with masked `credentialHints`, never a
 * value. The vendor account belongs to the workspace (the vendor bills it per verification), and
 * the operator decides which vendors are offered at all (`offered`).
 */
export type AccreditationProvider = FundRoomSchemas["AccreditationProviderInfo"];
export type AccreditationVendor = AccreditationProvider["driver"];
export type AccreditationCredentialField = AccreditationProvider["credentialFields"][number];
export type AccreditationConnection = FundRoomSchemas["AccreditationConnection"];

export const ACCREDITATION_KEY = ["accreditation"] as const;

export const accreditationProvidersQuery = queryOptions({
  queryKey: [...ACCREDITATION_KEY, "providers"],
  queryFn: () => call(api().GET("/accreditation/providers")),
  staleTime: 5 * 60_000,
});

export const accreditationConnectionQuery = queryOptions({
  queryKey: [...ACCREDITATION_KEY, "connection"],
  queryFn: () => call(api().GET("/accreditation/connection")),
});

// --- labels -----------------------------------------------------------------------------------

/**
 * The credential field's label in the reader's language (`<driver>.<key>` is frozen in the
 * contract). A field the SPA has no copy for (a newer server) falls back to the adapter's label.
 */
export function credentialFieldLabel(
  driver: AccreditationVendor,
  field: AccreditationCredentialField,
): string {
  switch (`${driver}.${field.key}`) {
    case "verifyinvestor.apiToken":
      return m.accreditation_field_verifyinvestor_api_token();
    case "verifyinvestor.webhookSecret":
      return m.accreditation_field_verifyinvestor_webhook_secret();
    case "verifyinvestor.portalName":
      return m.accreditation_field_verifyinvestor_portal_name();
    case "parallel-markets.apiKey":
      return m.accreditation_field_parallel_markets_api_key();
    case "parallel-markets.clientId":
      return m.accreditation_field_parallel_markets_client_id();
    case "parallel-markets.webhookSigningKey":
      return m.accreditation_field_parallel_markets_webhook_signing_key();
    case "verifyinvestor.environment":
    case "parallel-markets.environment":
      return m.accreditation_field_environment();
    default:
      return field.label;
  }
}

/** Help text under a credential field, when we have better copy than the adapter's. */
export function credentialFieldHelp(
  driver: AccreditationVendor,
  field: AccreditationCredentialField,
): string | undefined {
  switch (`${driver}.${field.key}`) {
    case "verifyinvestor.webhookSecret":
    case "parallel-markets.webhookSigningKey":
      return m.accreditation_field_webhook_secret_help();
    case "verifyinvestor.portalName":
      return m.accreditation_field_verifyinvestor_portal_name_help();
    case "parallel-markets.clientId":
      return m.accreditation_field_parallel_markets_client_id_help();
    default:
      return field.help;
  }
}

/** A select option's label (`staging`/`demo`/`production`); unknown ones print as given. */
export function credentialOptionLabel(option: string): string {
  switch (option) {
    case "staging":
      return m.accreditation_option_staging();
    case "demo":
      return m.accreditation_option_demo();
    case "production":
      return m.accreditation_option_production();
    default:
      return option;
  }
}

// --- errors -----------------------------------------------------------------------------------

function detail(error: unknown, key: string): unknown {
  if (!isApiError(error)) return undefined;
  const flat = error.body.error[key];
  if (flat !== undefined) return flat;
  // Flattened in practice; tolerate a nested `details` too.
  return (error.body.error["details"] as Record<string, unknown> | undefined)?.[key];
}

export function accreditationErrorCode(error: unknown): string | undefined {
  return isApiError(error) ? error.code : undefined;
}

/** One sentence per refusal the accreditation routes give; anything else is the generic copy. */
export function describeAccreditationError(error: unknown): string {
  switch (accreditationErrorCode(error)) {
    case "accreditation_credentials_invalid":
      return m.accreditation_error_credentials_invalid();
    case "accreditation_driver_not_offered":
      return m.accreditation_error_not_offered();
    case "accreditation_provider_error":
      return m.accreditation_error_provider();
    default:
      return describeError(error).body;
  }
}

/** The credential fields the vendor named when it refused them (422 `details.fields`). */
export function invalidFields(error: unknown): readonly string[] {
  if (accreditationErrorCode(error) !== "accreditation_credentials_invalid") return [];
  const fields = detail(error, "fields");
  return Array.isArray(fields) ? fields.filter((f): f is string => typeof f === "string") : [];
}
