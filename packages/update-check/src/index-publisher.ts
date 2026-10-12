import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type BuildIndexResult,
  buildReleaseIndex,
  type GitHubRelease,
  parseGitHubReleases,
} from "./index-builder.js";
import { parseReleaseIndex, type ReleaseIndex } from "./release-index.js";

/*
 * Publishes the release index (B-11): reads the published `index.json` from the R2 bucket, builds
 * the next one (`index-builder.ts`), uploads it over R2's S3 API, reads it back from the bucket,
 * then from the public URL.
 *
 * - **The bucket is the source of truth**, read over the S3 API, never through the CDN: a copy
 *   cached for up to 5 minutes could predate a security flag and lose it on the next write.
 * - **The S3 client is the aws CLI** (preinstalled on GitHub's runners; `AWS_BIN` overrides), run
 *   with an environment of its own: the two R2 keys, region `auto`, no config or credentials
 *   file, no instance metadata, and checksums only where an operation requires them (R2 does
 *   not accept every checksum the CLI sends by default).
 * - **Upload:** `Content-Type: application/json`, `Cache-Control: public, max-age=300`. Skipped
 *   when the bytes are unchanged. Then a read-back over S3 (same bytes, same headers), and over
 *   the public URL: a cache-busted GET must return the new bytes, and the plain URL, which a
 *   CDN may still serve from cache, must at least hold a valid index.
 * - **No silent first publish.** A bucket with no `index.json` is refused unless `firstPublish`:
 *   an emptied or swapped bucket would otherwise be rebuilt from GitHub alone and lose every
 *   security flag set by dispatch.
 * - **Loud.** Anything missing or wrong is a thrown error and a failed job; the index is a
 *   release requirement, not a best effort.
 * - **Runs bundled.** The workflow runs `dist/release-index.mjs` (this module and its
 *   dependencies in one file, built in a job with no secrets) in a job that installs nothing.
 */

export const INDEX_KEY = "index.json";
export const INDEX_CONTENT_TYPE = "application/json";
export const INDEX_CACHE_CONTROL = "public, max-age=300";

/** The bucket, as the publisher needs it. */
export interface IndexStore {
  /** The published object, or undefined when there is none. */
  get(): Promise<StoredIndex | undefined>;
  put(body: string): Promise<void>;
}

export interface StoredIndex {
  readonly body: string;
  readonly contentType?: string | undefined;
  readonly cacheControl?: string | undefined;
}

export interface R2Target {
  /** `https://<account_id>.r2.cloudflarestorage.com` */
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly key?: string | undefined;
}

export interface AwsCliOptions {
  /** The aws executable; default `aws`. */
  readonly bin?: string | undefined;
  /** PATH for the child (the aws CLI's own interpreter lookup). */
  readonly path?: string | undefined;
}

function runAws(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { env, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr).trim() || error.message;
        reject(Object.assign(new Error(`aws ${args[0]} ${args[1]}: ${detail}`), { stderr }));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/** An IndexStore over the aws CLI's `s3api get-object` / `put-object`. */
export function createAwsCliStore(target: R2Target, options: AwsCliOptions = {}): IndexStore {
  const bin = options.bin ?? "aws";
  const key = target.key ?? INDEX_KEY;
  // Nothing from the caller's environment but PATH: no profile, no config file, no other keys.
  const env: NodeJS.ProcessEnv = {
    PATH: options.path ?? process.env["PATH"] ?? "",
    HOME: tmpdir(),
    AWS_ACCESS_KEY_ID: target.accessKeyId,
    AWS_SECRET_ACCESS_KEY: target.secretAccessKey,
    AWS_REGION: "auto",
    AWS_DEFAULT_REGION: "auto",
    AWS_CONFIG_FILE: devNull,
    AWS_SHARED_CREDENTIALS_FILE: devNull,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
    AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
    AWS_PAGER: "",
  };
  const common = ["--endpoint-url", target.endpoint, "--bucket", target.bucket, "--key", key];
  const withDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
    const dir = await mkdtemp(join(tmpdir(), "release-index-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  return {
    get: () =>
      withDir(async (dir) => {
        const file = join(dir, "index.json");
        let stdout: string;
        try {
          ({ stdout } = await runAws(
            bin,
            ["s3api", "get-object", ...common, "--output", "json", file],
            env,
          ));
        } catch (error) {
          if (/NoSuchKey|\(404\)/u.test(String((error as { stderr?: unknown }).stderr ?? ""))) {
            return undefined;
          }
          throw error;
        }
        const meta = JSON.parse(stdout) as { ContentType?: string; CacheControl?: string };
        return {
          body: await readFile(file, "utf8"),
          contentType: meta.ContentType,
          cacheControl: meta.CacheControl,
        };
      }),
    put: (body) =>
      withDir(async (dir) => {
        const file = join(dir, "index.json");
        await writeFile(file, body, "utf8");
        await runAws(
          bin,
          [
            "s3api",
            "put-object",
            ...common,
            "--body",
            file,
            "--content-type",
            INDEX_CONTENT_TYPE,
            "--cache-control",
            INDEX_CACHE_CONTROL,
            "--output",
            "json",
          ],
          env,
        );
      }),
  };
}

export interface VerifyPublicOptions {
  readonly fetch?: typeof fetch | undefined;
  readonly attempts?: number | undefined;
  readonly delayMs?: number | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The public URL serves the new bytes (cache-busted) and a valid index (as cached). Each GET is
 * retried (propagation, a transient CDN error); throws when one never passes.
 */
export async function verifyPublicIndex(
  url: string,
  body: string,
  options: VerifyPublicOptions = {},
): Promise<void> {
  const get = options.fetch ?? fetch;
  const attempts = options.attempts ?? 10;
  const sleep = options.sleep ?? sleepMs;
  /** GETs `target` until `check` (the problem, or "" when fine) passes. */
  const until = async (target: string, check: (res: Response, text: string) => string) => {
    let last = "";
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(options.delayMs ?? 15_000);
      try {
        const res = await get(target, { headers: { accept: "application/json" } });
        last = res.ok ? check(res, await res.text()) : `HTTP ${res.status}`;
        if (!res.ok) await res.body?.cancel().catch(() => {});
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      if (last === "") return;
    }
    throw new Error(`${target} does not serve the uploaded index: ${last}`);
  };
  const busted = new URL(url);
  busted.searchParams.set("v", createHash("sha256").update(body).digest("hex").slice(0, 16));
  await until(busted.href, (res, text) => {
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith(INDEX_CONTENT_TYPE)) return `content-type ${JSON.stringify(type)}`;
    return text === body ? "" : "different bytes (not propagated yet?)";
  });
  // The URL readers fetch: possibly a cached, older copy, but it must be a valid one.
  await until(url, (_res, text) => {
    const parsed = parseReleaseIndex(text);
    return parsed.ok ? "" : `not a valid index (${parsed.reason})`;
  });
}

export interface PublishOptions {
  readonly store: IndexStore;
  readonly releases: readonly GitHubRelease[];
  readonly markSecurity?: readonly string[] | undefined;
  readonly clearSecurity?: readonly string[] | undefined;
  readonly allowRemoval?: boolean | undefined;
  /** Build from GitHub alone, ignoring (and replacing) the published index. */
  readonly ignoreCurrent?: boolean | undefined;
  /** The bucket holds no index yet, and that is expected (the bootstrap run). */
  readonly firstPublish?: boolean | undefined;
  /** Build and validate, upload nothing. */
  readonly dryRun?: boolean | undefined;
  /** The public URL to read back (`RELEASE_INDEX_URL`); undefined skips that check. */
  readonly publicUrl?: string | undefined;
  readonly verify?: VerifyPublicOptions | undefined;
  readonly log?: ((line: string) => void) | undefined;
}

export interface PublishResult {
  readonly index: ReleaseIndex;
  readonly body: string;
  readonly uploaded: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

export async function publishReleaseIndex(options: PublishOptions): Promise<PublishResult> {
  const log = options.log ?? (() => {});
  let current: ReleaseIndex | undefined;
  let currentBody: string | undefined;
  if (options.ignoreCurrent === true) {
    log("ignoring the published index (ignore-current): building from GitHub alone");
  } else {
    const stored = await options.store.get();
    if (stored === undefined) {
      if (options.firstPublish !== true && options.dryRun !== true) {
        throw new Error(
          "the bucket holds no index.json. If this is the first publish, run Release index by " +
            "hand with first-publish; otherwise the bucket was emptied or changed, and publishing " +
            "from GitHub alone would drop every security flag set by dispatch (runbook: releasing.md)",
        );
      }
      log("no index published yet: building the first one");
    } else if (options.firstPublish === true) {
      throw new Error("first-publish, but the bucket already holds an index.json: run without it");
    } else {
      const parsed = parseReleaseIndex(stored.body);
      if (!parsed.ok) {
        throw new Error(
          `the published index does not validate (${parsed.reason}); re-run with ignore-current ` +
            "to rebuild it from GitHub, passing again any security versions set by dispatch",
        );
      }
      current = parsed.index;
      currentBody = stored.body;
    }
  }

  const built: BuildIndexResult = buildReleaseIndex({
    current,
    releases: options.releases,
    markSecurity: options.markSecurity,
    clearSecurity: options.clearSecurity,
    allowRemoval: options.allowRemoval,
  });
  if (!built.ok) throw new Error(`release index not built: ${built.reason}`);
  if (built.skippedTags.length > 0)
    log(`skipped (not a v<x.y.z> tag): ${built.skippedTags.join(", ")}`);
  log(
    `index: ${built.index.releases.length} releases, latest ${built.index.latest ?? "(none: no stable release)"}, ` +
      `security ${
        built.index.releases
          .filter((r) => r.security)
          .map((r) => r.version)
          .join(", ") || "(none)"
      }; ` +
      `added ${built.added.join(", ") || "(none)"}; removed ${built.removed.join(", ") || "(none)"}`,
  );
  const result = (uploaded: boolean): PublishResult => ({
    index: built.index,
    body: built.body,
    uploaded,
    added: built.added,
    removed: built.removed,
  });
  if (options.dryRun === true) {
    log("dry run: nothing uploaded");
    return result(false);
  }

  let uploaded = false;
  if (currentBody === built.body) log("unchanged: not uploading");
  else {
    await options.store.put(built.body);
    uploaded = true;
    const back = await options.store.get();
    if (back?.body !== built.body)
      throw new Error("read-back from the bucket differs from the upload");
    if (back.contentType !== INDEX_CONTENT_TYPE || back.cacheControl !== INDEX_CACHE_CONTROL) {
      throw new Error(
        `uploaded with Content-Type ${JSON.stringify(back.contentType)} and Cache-Control ` +
          `${JSON.stringify(back.cacheControl)}, expected ${INDEX_CONTENT_TYPE} / ${INDEX_CACHE_CONTROL}`,
      );
    }
    log(`uploaded ${INDEX_KEY} (${Buffer.byteLength(built.body, "utf8")} bytes) and read it back`);
  }
  if (options.publicUrl !== undefined) {
    await verifyPublicIndex(options.publicUrl, built.body, options.verify);
    log(`${options.publicUrl} serves it`);
  }
  return result(uploaded);
}

/** The environment the CLI reads: the GitHub Environment `releases`. */
export const ENV_KEYS = {
  endpoint: "R2_RELEASES_ENDPOINT",
  bucket: "R2_RELEASES_BUCKET",
  accessKeyId: "R2_RELEASES_ACCESS_KEY_ID",
  secretAccessKey: "R2_RELEASES_SECRET_ACCESS_KEY",
  publicUrl: "RELEASE_INDEX_URL",
} as const;

export const USAGE = `usage: node packages/update-check/dist/release-index.mjs --releases <prepared.json>
       [--security <versions>] [--not-security <versions>] [--allow-removal] [--ignore-current]
       [--first-publish] [--dry-run] [--out <file>]
       (<prepared.json>: the output of scripts/release/release-index.mjs prepare)
env:   ${Object.values(ENV_KEYS).join(", ")} (all required; a dry run needs none of them
       but then builds as if nothing were published), AWS_BIN (default aws)`;

const list = (text: string | undefined): string[] =>
  (text ?? "").split(/[\s,]+/u).filter((s) => s !== "");

function checkUrl(name: string, value: string, allowHttp: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${name} is not a URL`;
  }
  if (url.protocol === "https:" || (allowHttp && url.protocol === "http:")) return undefined;
  return `${name} must be https`;
}

export interface MainDeps {
  readonly fetch?: typeof fetch | undefined;
  readonly verify?: VerifyPublicOptions | undefined;
  readonly log?: ((line: string) => void) | undefined;
  /** Accept http endpoints and URLs (the rehearsal's local S3 server). */
  readonly allowHttp?: boolean | undefined;
}

/** The CLI. Returns the exit code: 0 published (or unchanged), 1 failed, 2 usage. */
export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: MainDeps = {},
): Promise<number> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const annotate = env["GITHUB_ACTIONS"] === "true" ? "::error::" : "";
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        releases: { type: "string" },
        security: { type: "string" },
        "not-security": { type: "string" },
        "allow-removal": { type: "boolean" },
        "ignore-current": { type: "boolean" },
        "first-publish": { type: "boolean" },
        "dry-run": { type: "boolean" },
        out: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    log(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  if (typeof values["releases"] !== "string") {
    log(USAGE);
    return 2;
  }
  const dryRun = values["dry-run"] === true;
  const allowHttp = deps.allowHttp === true;

  const missing = Object.values(ENV_KEYS).filter((k) => (env[k] ?? "").trim() === "");
  if (missing.length > 0 && !(dryRun && missing.length === Object.values(ENV_KEYS).length)) {
    log(
      `${annotate}The GitHub Environment \`releases\` is not configured: ${missing.join(", ")} ` +
        "unset. The release index (https://releases.fundroom.io/index.json) is part of every " +
        'release; set the environment up (docs/runbooks/releasing.md, "Release index"), then ' +
        're-run this job ("Re-run failed jobs").',
    );
    return 1;
  }
  const bad = [
    missing.includes(ENV_KEYS.endpoint)
      ? undefined
      : checkUrl(ENV_KEYS.endpoint, env[ENV_KEYS.endpoint] ?? "", allowHttp),
    missing.includes(ENV_KEYS.publicUrl)
      ? undefined
      : checkUrl(ENV_KEYS.publicUrl, env[ENV_KEYS.publicUrl] ?? "", allowHttp),
  ].filter((m) => m !== undefined);
  if (bad.length > 0) {
    log(`${annotate}${bad.join("; ")}`);
    return 1;
  }

  try {
    const releases = parseGitHubReleases(
      JSON.parse(await readFile(String(values["releases"]), "utf8")),
    );
    const configured = missing.length === 0;
    const store: IndexStore = configured
      ? createAwsCliStore(
          {
            endpoint: String(env[ENV_KEYS.endpoint]).trim(),
            bucket: String(env[ENV_KEYS.bucket]).trim(),
            accessKeyId: String(env[ENV_KEYS.accessKeyId]).trim(),
            secretAccessKey: String(env[ENV_KEYS.secretAccessKey]).trim(),
          },
          { bin: env["AWS_BIN"], path: env["PATH"] },
        )
      : {
          get: async () => undefined,
          put: async () => {
            throw new Error("not configured");
          },
        };
    const result = await publishReleaseIndex({
      store,
      releases,
      markSecurity: list(values["security"] as string | undefined),
      clearSecurity: list(values["not-security"] as string | undefined),
      allowRemoval: values["allow-removal"] === true,
      ignoreCurrent: values["ignore-current"] === true,
      firstPublish: values["first-publish"] === true,
      dryRun,
      publicUrl: configured ? String(env[ENV_KEYS.publicUrl]).trim() : undefined,
      verify: { ...deps.verify, fetch: deps.fetch ?? deps.verify?.fetch },
      log,
    });
    if (typeof values["out"] === "string") await writeFile(values["out"], result.body, "utf8");
    return 0;
  } catch (error) {
    log(`${annotate}${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
