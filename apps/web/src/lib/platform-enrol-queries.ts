import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { callNoContent } from "./access-admin-queries.js";
import { api, call } from "./api.js";
import type { JsonRecord } from "./webauthn.js";

/*
 * Operator enrolment (E3.10 FR2, ADR-0058): a new operator proves a factor BEFORE they are
 * granted, so the grant's "factor older than the grant" rule can hold. `fundroom operator
 * enrol-link <email>` prints a single-use link (`/platform/enrol?token=…`, never emailed); the
 * page asks for the address, emails it a code, and the code opens a short (15 min)
 * enrolment-only session (`__Host-op_enrol`). That session is not a normal one: it may only
 * enrol an authenticator app or register a passkey — through `/platform/enrol/*`, not
 * `/auth/*` — and either ends it.
 *
 * `start` always answers `{ ok: true }` (the code goes out only when token and address match),
 * so the page never says which of the two was wrong.
 */
export type PlatformEnrolSession = FundRoomSchemas["PlatformEnrolSession"];

export const ENROL_SESSION_KEY = ["platform-enrol", "session"] as const;

/** `GET /platform/enrol/session`; a 404 means "no enrolment session in this browser". */
export const enrolSessionQuery = queryOptions({
  queryKey: ENROL_SESSION_KEY,
  queryFn: () => call(api().GET("/platform/enrol/session")),
  staleTime: 0,
  retry: false,
});

export function startEnrol(token: string, email: string): Promise<{ ok: true }> {
  return call(api().POST("/platform/enrol/start", { body: { token, email } }));
}

export function verifyEnrol(
  token: string,
  email: string,
  code: string,
): Promise<PlatformEnrolSession> {
  return call(api().POST("/platform/enrol/verify", { body: { token, email, code } }));
}

export function endEnrolSession(): Promise<void> {
  return callNoContent(api().DELETE("/platform/enrol/session"));
}

export function beginEnrolTotp(): Promise<FundRoomSchemas["TotpEnrolment"]> {
  return call(api().POST("/platform/enrol/totp"));
}

/** Confirms the first code; the answer is the recovery codes and the session is over. */
export function confirmEnrolTotp(code: string): Promise<FundRoomSchemas["RecoveryCodes"]> {
  return call(api().POST("/platform/enrol/totp/confirm", { body: { code } }));
}

export function beginEnrolPasskey(): Promise<FundRoomSchemas["PasskeyRegistrationBegin"]> {
  return call(api().POST("/platform/enrol/passkey/begin"));
}

/** Registers the passkey; the session is over. */
export function finishEnrolPasskey(body: {
  challengeId: string;
  response: JsonRecord;
}): Promise<FundRoomSchemas["Passkey"]> {
  return call(api().POST("/platform/enrol/passkey/finish", { body }));
}
