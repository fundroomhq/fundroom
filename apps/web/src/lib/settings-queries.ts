import type { FundRoomSchemas } from "@fundroom/sdk";
import { m } from "../paraglide/messages.js";
import { api, call, isApiError } from "./api.js";

/*
 * Workspace settings (E2.7): the access & sign-in settings form and the danger zone. The GET
 * of `/access/settings` is `accessSettingsQuery` in `lib/queries.ts` (E1.1); the writes live
 * here. Every danger-zone body carries the workspace slug typed back as `confirm`.
 */
export type AccessSettings = FundRoomSchemas["AccessSettings"];
export type AccessSettingsPatch = Partial<AccessSettings>;

export function patchAccessSettings(body: AccessSettingsPatch): Promise<AccessSettings> {
  return call(api().PATCH("/access/settings", { body }));
}

export function transferOwnership(body: {
  toMembershipId: string;
  confirm: string;
  keepOwner: boolean;
}) {
  return call(api().POST("/access/ownership/transfer", { body }));
}

export function revokeAllSessions(body: { confirm: string; includeStaff: boolean }) {
  return call(api().POST("/access/sessions/revoke-all", { body }));
}

export function deleteWorkspace(confirm: string) {
  return call(api().DELETE("/workspace", { body: { confirm } }));
}

/** The `reason` a refusal carries (flattened into `error`), if any. */
export function errorReason(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined;
  const reason = error.body.error["reason"];
  return typeof reason === "string" ? reason : undefined;
}

/**
 * The danger-zone refusals that deserve their own words: a slug typed wrong (the dialog makes
 * that nearly impossible, but the slug can change under an open tab) and a legal hold, which
 * blocks deletion by design. Anything else falls back to `describeError`.
 */
export function dangerErrorMessage(error: unknown): string | undefined {
  switch (errorReason(error)) {
    case "confirmation_mismatch":
      return m.danger_error_confirmation_mismatch();
    case "legal_hold":
      return m.danger_error_legal_hold();
    default:
      return undefined;
  }
}
