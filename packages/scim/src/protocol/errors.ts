/*
 * SCIM protocol errors (RFC 7644 §3.12). The body carries `status` as a STRING (Okta and the
 * Entra validator both check the type) and an optional `scimType`. `ScimError` is what the pure
 * protocol layer and the service's protocol methods throw; the `/scim/v2` routes render it.
 */

export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

export type ScimErrorType =
  | "invalidFilter"
  | "tooMany"
  | "uniqueness"
  | "mutability"
  | "invalidSyntax"
  | "invalidPath"
  | "noTarget"
  | "invalidValue"
  | "invalidVers"
  | "sensitive";

export interface ScimErrorBody {
  readonly schemas: readonly [typeof SCIM_ERROR_SCHEMA];
  readonly status: string;
  readonly scimType?: ScimErrorType;
  readonly detail?: string;
}

export class ScimError extends Error {
  override readonly name = "ScimError";
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: ScimErrorType | undefined,
  ) {
    super(detail);
  }

  toBody(): ScimErrorBody {
    return scimErrorBody(this.status, this.detail, this.scimType);
  }
}

export function scimErrorBody(
  status: number,
  detail?: string | undefined,
  scimType?: ScimErrorType | undefined,
): ScimErrorBody {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType === undefined ? {} : { scimType }),
    ...(detail === undefined ? {} : { detail }),
  };
}

export function isScimError(error: unknown): error is ScimError {
  return error instanceof ScimError;
}

/** Shorthands for the 400s the protocol layer throws. */
export const scimInvalidFilter = (detail: string): ScimError =>
  new ScimError(400, detail, "invalidFilter");
export const scimInvalidSyntax = (detail: string): ScimError =>
  new ScimError(400, detail, "invalidSyntax");
export const scimInvalidPath = (detail: string): ScimError =>
  new ScimError(400, detail, "invalidPath");
export const scimInvalidValue = (detail: string): ScimError =>
  new ScimError(400, detail, "invalidValue");
export const scimMutability = (detail: string): ScimError =>
  new ScimError(400, detail, "mutability");
export const scimUniqueness = (detail: string): ScimError =>
  new ScimError(409, detail, "uniqueness");
export const scimNotFound = (detail = "resource not found"): ScimError =>
  new ScimError(404, detail);
