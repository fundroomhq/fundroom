/*
 * `@fundroom/update-check/publish`: building and publishing the release index (B-11), for the
 * release workflow (scripts/release/release-index.mjs) and its rehearsal. A separate entry point so
 * the server, which only reads the index, never loads the publisher's child_process and fs code.
 */
export {
  type BuildIndexOptions,
  type BuildIndexResult,
  buildReleaseIndex,
  type GitHubRelease,
  hasSecurityEntry,
  parseGitHubReleases,
  SECURITY_MARKER,
  versionOfTag,
} from "./index-builder.js";
export {
  type AwsCliOptions,
  createAwsCliStore,
  ENV_KEYS,
  INDEX_CACHE_CONTROL,
  INDEX_CONTENT_TYPE,
  INDEX_KEY,
  type IndexStore,
  type MainDeps,
  main,
  type PublishOptions,
  type PublishResult,
  publishReleaseIndex,
  type R2Target,
  type StoredIndex,
  USAGE,
  type VerifyPublicOptions,
  verifyPublicIndex,
} from "./index-publisher.js";
