import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createOutboundHttp } from "@fundroom/outbound-http";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUpdateChecker } from "./checker.js";
import type { GitHubRelease } from "./index-builder.js";
import { main } from "./index-publisher.js";
import type { UpdateStatus } from "./status.js";

/*
 * The release-index rehearsal (B-11): the real publisher CLI (`main`, what the bundled
 * dist/release-index.mjs runs; the bundle itself is smoke-tested in index-publisher.test.ts) with
 * the real aws CLI against a local S3 server standing in for R2, then the real update checker,
 * over the guarded outbound client the server builds (5 s, 256 KiB, no redirects), reading the
 * object the server serves over HTTP. It walks the index through the release line: an empty
 * bucket refused without `--first-publish`, release candidates only (no `latest`), the first
 * stable release, a security release found by its CHANGELOG notes, dispatch marking and clearing
 * flags, flags carried across a later release, an unchanged re-run, and a refused removal.
 *
 * SeaweedFS is the S3 server CI already pulls (storage-s3's contract); with no `-s3.config` it
 * accepts any keys and serves objects anonymously, which is what R2's public bucket does on
 * releases.fundroom.io. Needs Docker and the aws CLI (`AWS_BIN` overrides; GitHub's runners have
 * it). http is allowed here only (`allowHttp`); the CLI refuses it otherwise.
 */
const IMAGE = process.env["FUNDROOM_TEST_S3_IMAGE"] ?? "chrislusf/seaweedfs:3.97";
const S3_PORT = 8333;
const BUCKET = "fundroom-releases";
const AWS = process.env["AWS_BIN"] ?? "aws";

let container: StartedTestContainer;
let endpoint = "";
let publicUrl = "";
const dir = mkdtempSync(join(tmpdir(), "release-index-rehearsal-"));

const NOTES_SECURITY =
  "### Patch Changes\n\n- [#41](https://github.com/fundroomhq/fundroom/pull/41) [`1a2b3c4`](https://github.com/fundroomhq/fundroom/commit/1a2b3c4) Thanks [@fundroomio](https://github.com/fundroomio)! - **Security:** sign-out now clears every session cookie.";

const gh = (tag: string, day: string, notes = ""): GitHubRelease => ({
  tag_name: tag,
  html_url: `https://github.com/fundroomhq/fundroom/releases/tag/${tag}`,
  published_at: `2026-${day}T12:00:00Z`,
  draft: false,
  notes,
});

const env = () => ({
  PATH: process.env["PATH"] ?? "",
  AWS_BIN: AWS,
  R2_RELEASES_ENDPOINT: endpoint,
  R2_RELEASES_BUCKET: BUCKET,
  R2_RELEASES_ACCESS_KEY_ID: "rehearsal",
  R2_RELEASES_SECRET_ACCESS_KEY: "rehearsal",
  RELEASE_INDEX_URL: publicUrl,
});

let run = 0;
async function publish(releases: GitHubRelease[], ...flags: string[]) {
  const file = join(dir, `releases-${++run}.json`);
  // As `gh api --paginate --slurp` writes it: an array of pages.
  writeFileSync(file, JSON.stringify([releases.slice(0, 2), releases.slice(2)]));
  const lines: string[] = [];
  const code = await main(["--releases", file, ...flags], env(), {
    allowHttp: true,
    log: (l) => lines.push(l),
    verify: { attempts: 5, delayMs: 200 },
  });
  return { code, log: lines.join("\n") };
}

async function statusOf(currentVersion: string): Promise<UpdateStatus> {
  const http = createOutboundHttp({
    allowedPrivateHosts: ["127.0.0.1"],
    userAgent: `FundRoom/${currentVersion}`,
    timeoutMs: 5_000,
    maxResponseBytes: 256 * 1024,
    maxRedirects: 0,
  });
  try {
    // A fresh checker per call: the checker caches a success for 12 hours.
    const checker = createUpdateChecker({ enabled: true, url: publicUrl, currentVersion, http });
    return await checker.check();
  } finally {
    await http.close();
  }
}

beforeAll(async () => {
  container = await new GenericContainer(IMAGE)
    .withCommand([
      "server",
      "-s3",
      "-dir=/data",
      "-ip.bind=0.0.0.0",
      "-master.volumeSizeLimitMB=64",
      "-volume.max=8",
    ])
    .withExposedPorts(S3_PORT)
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000)
    .start();
  // 127.0.0.1 rather than `localhost`: the outbound guard exempts exactly the listed host.
  const host = container.getHost() === "localhost" ? "127.0.0.1" : container.getHost();
  endpoint = `http://${host}:${container.getMappedPort(S3_PORT)}`;
  publicUrl = `${endpoint}/${BUCKET}/index.json`;
  const awsEnv = {
    PATH: process.env["PATH"] ?? "",
    HOME: tmpdir(),
    AWS_ACCESS_KEY_ID: "rehearsal",
    AWS_SECRET_ACCESS_KEY: "rehearsal",
    AWS_REGION: "auto",
    AWS_CONFIG_FILE: devNull,
    AWS_SHARED_CREDENTIALS_FILE: devNull,
  };
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await promisify(execFile)(
        AWS,
        ["s3api", "create-bucket", "--endpoint-url", endpoint, "--bucket", BUCKET],
        { env: awsEnv },
      );
      break;
    } catch (error) {
      if (/BucketAlready/u.test(String((error as { stderr?: unknown }).stderr))) break;
      if ((error as { code?: unknown }).code === "ENOENT") {
        throw new Error(`the rehearsal needs the aws CLI (${AWS} not found; set AWS_BIN)`);
      }
      if (Date.now() > deadline) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
});

afterAll(async () => {
  await container?.stop();
});

describe("release index: publish, serve, read", () => {
  const rc0 = gh("v1.0.0-rc.0", "10-09");
  const rc1 = gh("v1.0.0-rc.1", "10-14");
  const v100 = gh("v1.0.0", "10-20");
  const v101 = gh("v1.0.1", "10-27", NOTES_SECURITY);
  const v102 = gh("v1.0.2", "10-28");
  const v103 = gh("v1.0.3", "11-02");
  const chart = gh("chart-v0.1.0", "10-10");

  it("release candidates only: no latest, every rc install is unknown", async () => {
    // An empty bucket is refused unless the run says it is the first publish.
    const refused = await publish([rc0, chart]);
    expect(refused.code).toBe(1);
    expect(refused.log).toMatch(/no index\.json.*first-publish/u);
    const r = await publish([rc0, chart], "--first-publish");
    expect(r.code, r.log).toBe(0);
    expect(r.log).toMatch(/no index published yet/u);
    expect(r.log).toMatch(/serves it/u);

    const res = await fetch(publicUrl);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await res.json()).toEqual({
      schemaVersion: 1,
      releases: [
        {
          version: "1.0.0-rc.0",
          date: "2026-10-09",
          url: "https://github.com/fundroomhq/fundroom/releases/tag/v1.0.0-rc.0",
          security: false,
        },
      ],
    });

    for (const v of ["1.0.0-rc.0", "1.0.0-rc.1", "0.0.0"]) {
      const s = await statusOf(v);
      expect(s.status, v).toBe("unknown");
      expect(s).not.toHaveProperty("latestVersion");
    }
  });

  it("the first stable release becomes latest", async () => {
    const r = await publish([v100, rc1, rc0]);
    expect(r.code, r.log).toBe(0);
    expect(await statusOf("1.0.0")).toMatchObject({ status: "current", latestVersion: "1.0.0" });
    expect(await statusOf("1.0.0-rc.1")).toMatchObject({
      status: "unknown",
      latestVersion: "1.0.0",
      releaseUrl: "https://github.com/fundroomhq/fundroom/releases/tag/v1.0.0",
    });
  });

  it("a release whose notes carry a security changeset is a security release", async () => {
    const r = await publish([v102, v101, v100, rc1, rc0]);
    expect(r.code, r.log).toBe(0);
    expect(r.log).toMatch(/security 1\.0\.1;/u);
    expect(await statusOf("1.0.0")).toMatchObject({
      status: "security_update",
      latestVersion: "1.0.2",
      securityReleases: ["1.0.1"],
    });
    expect(await statusOf("1.0.1")).toMatchObject({ status: "update_available" });
    expect(await statusOf("1.0.2")).toMatchObject({ status: "current" });
  });

  it("dispatch marks and clears flags, and a later release carries them over", async () => {
    const all = [v102, v101, v100, rc1, rc0];
    const marked = await publish(all, "--security", "v1.0.2", "--not-security", "1.0.1");
    expect(marked.code, marked.log).toBe(0);
    expect(await statusOf("1.0.1")).toMatchObject({
      status: "security_update",
      securityReleases: ["1.0.2"],
    });

    const later = await publish([v103, ...all]);
    expect(later.code, later.log).toBe(0);
    expect(await statusOf("1.0.0")).toMatchObject({
      status: "security_update",
      latestVersion: "1.0.3",
      securityReleases: ["1.0.2"],
    });
    expect(await statusOf("1.0.2")).toMatchObject({ status: "update_available" });

    const again = await publish([v103, ...all]);
    expect(again.code, again.log).toBe(0);
    expect(again.log).toMatch(/unchanged: not uploading/u);
  });

  it("refuses to drop a published version without allow-removal", async () => {
    const r = await publish([v102, v101, v100, rc1, rc0]);
    expect(r.code).toBe(1);
    expect(r.log).toMatch(/1\.0\.3, which GitHub no longer lists/u);
    expect(await statusOf("1.0.2")).toMatchObject({ latestVersion: "1.0.3" });
  });
});
