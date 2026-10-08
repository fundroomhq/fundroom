/*
 * OpenFGA relationship engine (E3.13, ADR-0061): RelationshipEnginePort over plain fetch. A store
 * per workspace (`seedhost-<workspaceId>`), a generated model encoding ADR-0032 ordering (see
 * model.ts), a paged full-diff sync, and Check / BatchCheck that always send
 * `context.current_time`.
 */
export { apiErrorOf, createOpenFgaHttp, type OpenFgaApiError } from "./client.js";
export {
  createOpenFgaEngine,
  OPENFGA_BATCH_CHECK_CHUNK,
  OPENFGA_DEFAULT_DEPTH_LIMIT,
  OPENFGA_ENGINE_DRIVER,
  OPENFGA_MAX_CONTEXTUAL_TUPLES,
  OPENFGA_READ_PAGE,
  OPENFGA_WRITE_CHUNK,
  type OpenFgaEngineLog,
  type OpenFgaEngineOptions,
  openFgaStoreName,
} from "./engine.js";
export {
  buildOpenFgaModel,
  formatModelRef,
  modelHash,
  type OpenFgaModel,
  openFgaTypeName,
  openFgaTypeTable,
  parseModelRef,
  RESERVED_TYPE_NAMES,
  ruleRelation,
  TIERS,
  VALID_WINDOW_CONDITION,
} from "./model.js";
export {
  encodeId,
  kindsOf,
  objectOf,
  type Projection,
  projectSnapshot,
  subjectUserOf,
  type TupleKey,
  tupleIdentity,
  userOf,
} from "./tuples.js";
