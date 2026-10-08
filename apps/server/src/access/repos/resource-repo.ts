/*
 * The resource resolver lives in `@fundroom/authz` since E3.2 (`lookupResource`, P1-03 and
 * R1-A1/A2), because an invitation's acceptance (identity) and a workspace import (portability)
 * derive rule paths with it too, and neither may import the server. This thin re-export keeps the
 * access routes' import stable and is the one place under `src/access/` that names it.
 */
export { lookupResource, type ResourceLookup } from "@fundroom/authz";
