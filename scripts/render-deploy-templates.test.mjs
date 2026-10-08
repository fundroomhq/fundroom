// node --test scripts/render-deploy-templates.test.mjs
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: "${VAR}" strings are Compose interpolations in the generated files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test (CI runs this file directly).
import { ENV, IMAGE_ENTRYPOINT } from "../deploy/platforms/source.mjs";
// biome-ignore lint/correctness/useImportExtensions: as above.
import { ROOT, renderAll, replaceBlock, staleFiles } from "./render-deploy-templates.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (/** @type {string} */ p) => readFileSync(join(ROOT, p), "utf8");

// `yaml` is a dependency of @fundroom/authz; scripts/ has no package.json of its own and the
// root hoists nothing (.npmrc), so resolve it from there rather than adding a root dependency.
const { parse: parseYaml } = createRequire(join(ROOT, "packages/authz/package.json"))("yaml");

/**
 * A strict parser for the TOML subset the generator emits (tables, arrays of tables, strings,
 * integers, booleans, arrays of those). Anything else throws, so a generator change that leaves
 * this subset fails here instead of on `fly deploy`. The full file was also checked once with a
 * spec-complete parser and Fly's JSON schema (see the E2.9 report).
 *
 * @param {string} text
 */
function parseTomlSubset(text) {
  /** @type {Record<string, any>} */
  const root = {};
  let table = root;
  const value = (/** @type {string} */ raw) => {
    const v = raw.trim();
    if (v.startsWith('"')) return JSON.parse(v);
    if (/^-?\d+$/u.test(v)) return Number(v);
    if (v === "true" || v === "false") return v === "true";
    if (v.startsWith("[") && v.endsWith("]")) {
      const inner = v.slice(1, -1).trim();
      return inner === "" ? [] : JSON.parse(`[${inner}]`);
    }
    throw new Error(`unsupported TOML value: ${v}`);
  };
  const walk = (/** @type {string[]} */ path, /** @type {boolean} */ array) => {
    let node = root;
    path.forEach((key, i) => {
      const last = i === path.length - 1;
      if (last && array) {
        node[key] ??= [];
        assert.ok(Array.isArray(node[key]), `${key} is not an array of tables`);
        node[key].push({});
        node = node[key].at(-1);
      } else {
        if (Array.isArray(node[key])) node = node[key].at(-1);
        else {
          if (last) assert.equal(node[key], undefined, `table [${path.join(".")}] defined twice`);
          node[key] ??= {};
          node = node[key];
        }
      }
    });
    return node;
  };
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    let m = /^\[\[([A-Za-z0-9_.-]+)\]\]$/u.exec(line);
    if (m) {
      table = walk(m[1].split("."), true);
      continue;
    }
    m = /^\[([A-Za-z0-9_.-]+)\]$/u.exec(line);
    if (m) {
      table = walk(m[1].split("."), false);
      continue;
    }
    m = /^([A-Za-z0-9_-]+) = (.+)$/u.exec(line);
    if (!m) throw new Error(`line ${i + 1}: not TOML this parser accepts: ${raw}`);
    assert.equal(table[m[1]], undefined, `line ${i + 1}: duplicate key ${m[1]}`);
    table[m[1]] = value(m[2]);
  }
  return root;
}

/** Compose list-form environment → object. */
const envList = (/** @type {string[]} */ list) =>
  Object.fromEntries(
    list.map((e) => {
      const i = e.indexOf("=");
      return i < 0 ? [e, null] : [e.slice(0, i), e.slice(i + 1)];
    }),
  );

test("committed outputs match the source (pnpm gen:deploy:check)", () => {
  assert.deepEqual(staleFiles(), []);
  const cli = spawnSync(process.execPath, [join(here, "render-deploy-templates.mjs"), "--check"]);
  assert.equal(cli.status, 0, cli.stderr.toString());
});

test("rendering is deterministic and byte-stable", () => {
  const a = renderAll();
  const b = renderAll();
  assert.deepEqual([...a.entries()], [...b.entries()]);
  for (const [path, content] of a) {
    assert.ok(content.endsWith("\n") && !content.endsWith("\n\n"), `${path}: one trailing LF`);
    assert.ok(!content.includes("\r"), `${path}: LF only`);
    assert.ok(
      !/[ \t]+$/mu.test(content.replace(/```[\s\S]*?```/gu, "")),
      `${path}: trailing space`,
    );
  }
});

test("README blocks are replaced between the markers only", () => {
  assert.throws(() => replaceBlock("no markers here", "x"), /markers/u);
});

test("IMAGE_ENTRYPOINT is the Dockerfile's ENTRYPOINT", () => {
  const line = read("deploy/docker/Dockerfile")
    .split("\n")
    .find((l) => l.startsWith("ENTRYPOINT "));
  assert.ok(line, "Dockerfile has an exec-form ENTRYPOINT");
  assert.deepEqual(JSON.parse(line.slice("ENTRYPOINT ".length)), IMAGE_ENTRYPOINT);
});

test("render.yaml: image-backed web + worker, pre-deploy migrate, shared generated secrets", () => {
  const bp = parseYaml(read("deploy/render/render.yaml"));
  const [web, worker] = bp.services;
  assert.equal(web.type, "web");
  assert.equal(worker.type, "worker");
  for (const s of [web, worker]) {
    assert.equal(s.runtime, "image");
    assert.match(s.image.url, /^ghcr\.io\/fundroomhq\/fundroom:/u);
    assert.equal(s.dockerCommand, undefined, "the image's ENTRYPOINT + CMD run `serve`");
  }
  assert.equal(web.preDeployCommand, [...IMAGE_ENTRYPOINT, "migrate"].join(" "));
  assert.equal(worker.preDeployCommand, undefined);
  assert.equal(web.healthCheckPath, "/readyz");

  const group = bp.envVarGroups[0];
  const byKey = (/** @type {any[]} */ vars) =>
    Object.fromEntries(vars.filter((v) => v.key).map((v) => [v.key, v]));
  const shared = byKey(group.envVars);
  for (const k of ["SEEDHOST_SECRET_KEY", "SESSION_SECRET", "METRICS_TOKEN"]) {
    assert.equal(shared[k]?.generateValue, true, `${k} generated once, shared`);
  }
  // A-2 FIX: Render generates one random value per NAME, so generating both names would be two
  // different keys. For one minor release only the pre-rename name is generated (the app reads it;
  // an older image needs it), and the new name appears nowhere in the Blueprint.
  for (const vars of [group.envVars, web.envVars, worker.envVars]) {
    assert.ok(
      !vars.some((/** @type {any} */ v) => v.key === "FUNDROOM_SECRET_KEY"),
      "FUNDROOM_SECRET_KEY is not generated next to SEEDHOST_SECRET_KEY",
    );
  }
  assert.equal(shared.MIGRATE_ON_START.value, "false");
  assert.equal(shared.STORAGE_DRIVER.value, "s3");
  assert.equal(shared.APP_ENV.value, "prod");
  assert.equal(shared.TRUST_PROXY.value, "true");

  const w = byKey(web.envVars);
  const k = byKey(worker.envVars);
  assert.equal(w.ROLES.value, "api,web");
  assert.equal(w.WORKER_MODE.value, "external");
  assert.equal(k.ROLES.value, "worker");
  assert.equal(k.WORKER_MODE, undefined, "ROLES=worker + WORKER_MODE=external is rejected");
  assert.equal(w.SETUP_TOKEN.generateValue, true);
  for (const key of ["BASE_URL", "SMTP_URL", "MAIL_FROM", "S3_SECRET_ACCESS_KEY"]) {
    assert.equal(w[key].sync, false, `${key} is prompted on the web service`);
    assert.deepEqual(k[key].fromService, { type: "web", name: web.name, envVarKey: key });
  }
  for (const s of [w, k]) {
    assert.deepEqual(s.DATABASE_URL.fromDatabase, {
      name: bp.databases[0].name,
      property: "connectionString",
    });
  }
  assert.equal(bp.databases[0].postgresMajorVersion, "18");
});

test("fly.toml: process groups, release_command, readiness check, no volumes", () => {
  const fly = parseTomlSubset(read("deploy/fly/fly.toml"));
  assert.equal(fly.deploy.release_command, "migrate");
  assert.deepEqual(fly.processes, {
    app: "serve --roles api,web",
    worker: "serve --roles worker",
  });
  assert.equal(fly.http_service.internal_port, 3000);
  assert.deepEqual(fly.http_service.processes, ["app"]);
  assert.equal(fly.http_service.checks[0].path, "/readyz");
  assert.equal(fly.mounts, undefined);
  assert.equal(fly.env.MIGRATE_ON_START, "false");
  assert.equal(fly.env.STORAGE_DRIVER, "s3");
  assert.equal(fly.env.APP_ENV, "prod");
  assert.equal(fly.env.TRUST_PROXY, "true");
  // App-wide env: anything process-specific here would reach both groups.
  assert.equal(fly.env.ROLES, undefined);
  assert.equal(fly.env.WORKER_MODE, undefined);
  assert.deepEqual(
    fly.vm.map((/** @type {any} */ v) => v.processes[0]),
    ["app", "worker"],
  );
});

test("Coolify stacks: one-shot migrate, all-in-one app, Traefik vs Caddy", () => {
  for (const [file, mode] of [
    ["deploy/coolify/compose.coolify.yaml", "traefik"],
    ["deploy/coolify/compose.coolify-caddy.yaml", "caddy"],
  ]) {
    const { services } = parseYaml(read(file));
    const app = envList(services.app.environment);
    const migrate = envList(services.migrate.environment);
    assert.deepEqual(services.migrate.command, ["migrate"]);
    assert.equal(services.migrate.exclude_from_hc, true);
    assert.equal(services.migrate.restart, "no");
    assert.deepEqual(services.app.command, ["serve"]);
    assert.equal(services.app.depends_on.migrate.condition, "service_completed_successfully");
    assert.equal(app.MIGRATE_ON_START, "false");
    assert.equal(app.ROLES, "api,web,worker");
    assert.equal(app.APP_ENV, "prod");
    assert.equal(app.TRUST_PROXY, "true");
    assert.equal(app.FUNDROOM_SECRET_KEY, migrate.FUNDROOM_SECRET_KEY);
    // A-2: the master key's variable was renamed, but Coolify's magic name must not be: Coolify
    // stores one generated value per name, so a new one would mint a new key for existing stacks.
    assert.equal(app.FUNDROOM_SECRET_KEY, "${SERVICE_REALBASE64_SEEDHOSTKEY}");
    // A-2 FIX: the old name too, from the SAME generated value, for one minor release: an older
    // image reads only SEEDHOST_SECRET_KEY and, without it, would generate a new key into /data.
    for (const env of [app, migrate]) {
      assert.equal(env.SEEDHOST_SECRET_KEY, env.FUNDROOM_SECRET_KEY, "both names, one value");
    }
    assert.equal(app.DATABASE_URL, migrate.DATABASE_URL);
    assert.equal(app.SMTP_URL, "${SMTP_URL:?}");
    if (mode === "traefik") {
      assert.ok("SERVICE_URL_APP_3000" in app, "Coolify routes a domain to app:3000");
      assert.ok(!("SERVICE_URL_APP_3000" in migrate), "only the app gets a domain");
      // Coolify's generated URL is http on a server without an https wildcard domain, which
      // APP_ENV=prod rejects; the operator enters the https URL instead.
      assert.equal(app.BASE_URL, "${BASE_URL:?}");
      assert.equal(migrate.BASE_URL, "${BASE_URL:?}");
      assert.equal(app.CUSTOM_DOMAIN_DRIVER, "manual");
      assert.equal(services.caddy, undefined);
    } else {
      assert.equal(app.CUSTOM_DOMAIN_DRIVER, "caddy-ask");
      assert.deepEqual(services.caddy.ports, ["80:80", "443:443", "443:443/udp"]);
      const mount = services.caddy.volumes[0].split(":")[0];
      assert.ok(existsSync(join(ROOT, "deploy/coolify", mount)), `${mount} resolves`);
    }
  }
});

test("renamed variables carry an upgrade note on every platform (A-2)", () => {
  const files = renderAll();
  const renamed = ENV.filter((e) => e.formerly);
  assert.ok(
    renamed.some((e) => e.name === "FUNDROOM_SECRET_KEY" && e.formerly === "SEEDHOST_SECRET_KEY"),
  );
  for (const path of [
    "deploy/render/render.yaml",
    "deploy/fly/fly.toml",
    "deploy/render/README.md",
    "deploy/railway/README.md",
    "deploy/fly/README.md",
    "deploy/coolify/README.md",
  ]) {
    const text = /** @type {string} */ (files.get(path));
    for (const e of renamed) {
      assert.ok(text.includes(e.formerly ?? ""), `${path} tells an upgrader about ${e.formerly}`);
    }
  }
  // Render: the comment sits right above the generated key, where a Blueprint editor looks.
  assert.match(
    /** @type {string} */ (files.get("deploy/render/render.yaml")),
    /# SEEDHOST_SECRET_KEY is FUNDROOM_SECRET_KEY's pre-rename name, kept here for one minor release.*\n\s+- key: SEEDHOST_SECRET_KEY\n\s+generateValue: true/u,
  );
  // Every note gives the safe order: the image first, the variable after, same value meanwhile.
  for (const path of ["deploy/railway/README.md", "deploy/fly/README.md"]) {
    assert.match(
      /** @type {string} */ (files.get(path)),
      /Upgrade the image first and rename after: an image from before the rename reads only `SEEDHOST_SECRET_KEY` and, without it, generates a new key/u,
      path,
    );
  }
});
