/*
 * Fixed-point decimal arithmetic — promoted to `@fundroom/decimal` in E2.5 (ADR-0043) when the
 * round calculator became its second consumer. This file stays so that the module's own imports
 * (`./decimal.js`, twenty of them) and `src/index.ts`'s public re-exports keep working and keep
 * meaning the same thing; the implementation, and the rationale for every choice in it, live in
 * the package.
 */
export * from "@fundroom/decimal";
