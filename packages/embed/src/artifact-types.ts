/*
 * The shape `apps/server` serves. Hand-written and importable from anywhere, so neither the
 * generated module nor the `@fundroom/embed/artifacts` entry point has to depend on the other
 * (dependency-cruiser's `no-circular` rule, and the compliance package's precedent of a
 * hand-written contract beside a generated body).
 */

/** One file served under `${basePath}/embed/v1/…` and `${basePath}/embed/<version>/…`. */
export interface EmbedArtifact {
  /** File name, no leading slash: `embed.js`, `embed.mjs`, `manifest.json`. */
  readonly path: string;
  /** Ready for the `Content-Type` header, charset included. */
  readonly contentType: string;
  /** The bytes, as UTF-8 text. Serving from memory keeps the image layout out of the routing. */
  readonly code: string;
  /** `sha384-<base64>`, usable verbatim as an `integrity` attribute (design/08 §5 "Versioning"). */
  readonly sha384: string;
  /** The package version these bytes were built from, for the pinned URL. */
  readonly version: string;
}
