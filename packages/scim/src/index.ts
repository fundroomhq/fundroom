/*
 * `@fundroom/scim` (E3.8, ADR-0056) — the kernel SCIM 2.0 provisioning service: per-workspace
 * bearer tokens, the Users/Groups protocol surface, the per-workspace `scim_user` projection and
 * SCIM group → staff role mapping.
 */
export { ScimAdminError, type ScimAdminErrorCode } from "./errors.js";
export {
  discoveryList,
  resourceTypeById,
  resourceTypes,
  schemaById,
  schemas,
  serviceProviderConfig,
} from "./protocol/discovery.js";
export {
  isScimError,
  SCIM_ERROR_SCHEMA,
  ScimError,
  type ScimErrorBody,
  type ScimErrorType,
  scimErrorBody,
} from "./protocol/errors.js";
export { type AttrPath, type FilterNode, parseFilter, parsePath } from "./protocol/filter.js";
export {
  applyGroupPatch,
  applyUserPatch,
  type PatchOperation,
  parsePatchRequest,
} from "./protocol/patch.js";
export {
  GROUP_SCHEMA,
  type GroupState,
  type JsonRecord,
  LIST_RESPONSE_SCHEMA,
  PATCH_OP_SCHEMA,
  parseGroupResource,
  parseUserResource,
  USER_SCHEMA,
  type UserState,
} from "./protocol/resources.js";
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type Page,
  type Projection,
  parseAttributeList,
  parsePage,
  project,
  wantsMembers,
} from "./protocol/serialize.js";
export { createScimService, effectiveRole, errorFields } from "./service.js";
export {
  isPlausibleScimToken,
  LEGACY_SCIM_TOKEN_PREFIX,
  SCIM_MAX_LIVE_TOKENS,
  SCIM_TOKEN_PREFIX,
  SCIM_TOKEN_RE,
  scimTokenHash,
} from "./token.js";
export type {
  MappableRole,
  ScimActor,
  ScimAdminView,
  ScimCtx,
  ScimGroupReadOptions,
  ScimGroupRow,
  ScimListQuery,
  ScimMembershipPort,
  ScimPrincipal,
  ScimProtocol,
  ScimService,
  ScimServiceDeps,
  ScimSystemActor,
  ScimTokenOptions,
  ScimTokenView,
  ScimUserRow,
} from "./types.js";
