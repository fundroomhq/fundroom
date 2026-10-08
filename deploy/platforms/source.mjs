/**
 * The single source of truth for the PaaS deploy templates (design/07 §1.3, E2.9 decision 3).
 *
 *   pnpm gen:deploy          # render deploy/{render,fly,coolify}/… and the README env blocks
 *   pnpm gen:deploy:check    # CI: exit 1 when a committed output is behind this file
 *
 * Nothing under deploy/render, deploy/fly or deploy/coolify (and the generated blocks of the
 * READMEs next to them, including deploy/railway/README.md) is edited by hand. Change the
 * catalogue or a platform descriptor here and re-run the generator.
 *
 * The catalogue lists only what a PaaS install sets. Everything else keeps the schema default
 * (packages/config/src/schema.ts); every name here must be a key of that schema, which
 * packages/config/src/deploy-env.test.ts enforces.
 *
 * Processes. A PaaS install runs two long-lived processes from the one image plus a migrate step:
 *   web    — ROLES=api,web: HTTP API + SPA; the platform's router sends traffic here.
 *   worker — ROLES=worker: the pg-boss consumer (WORKER_MODE unset: config rejects
 *            ROLES=worker with WORKER_MODE=external).
 *   migrate — runs with the web process's environment everywhere (Render preDeployCommand,
 *            Railway pre-deploy, Fly release_command, the Coolify `migrate` service), so it
 *            has no column of its own. It loads the full config, so it needs MAIL_FROM etc. too.
 * Two processes on two machines cannot share a volume, so documents live in S3
 * (STORAGE_DRIVER=s3). Coolify is the exception: one VPS, one all-in-one process, a volume.
 */

/** The published image (release workflow: `latest`, `<major>`, `<major>.<minor>`, `<version>`). */
export const IMAGE = "ghcr.io/fundroomhq/fundroom:latest";

/**
 * The image's ENTRYPOINT, verbatim from deploy/docker/Dockerfile (the node test asserts they
 * match). Render's Docker Command / pre-deploy command and Railway's start / pre-deploy command
 * *replace* the ENTRYPOINT rather than appending to it, so on those platforms a command has to
 * spell the whole thing out; Fly and Compose keep the ENTRYPOINT and replace only CMD.
 */
export const IMAGE_ENTRYPOINT = [
  "/nodejs/bin/node",
  "--import",
  "/app/dist/instrumentation.js",
  "/app/dist/cli.js",
];

export const PORT = 3000;
export const READINESS_PATH = "/readyz";
export const LIVENESS_PATH = "/healthz";

/**
 * How a value reaches the process:
 *   literal  — `value` (a string, or `{ web, worker }` when the processes differ)
 *   generate — a random secret the platform creates once (`bytes` of entropy)
 *   prompt   — the operator supplies it when creating the stack (`example` shown to them)
 *   database — the platform's Postgres connection string
 *   baseUrl  — the service's public https URL
 *
 * `processes` is where the variable is set; `platforms.<id>` overrides any field for one
 * platform, and `platforms.<id> = false` leaves the variable out there.
 *
 * @typedef {"web" | "worker"} Process
 * @typedef {{
 *   name: string,
 *   description: string,
 *   kind: "literal" | "generate" | "prompt" | "database" | "baseUrl",
 *   processes: Process[],
 *   secret?: boolean,
 *   required?: boolean,
 *   value?: string | Partial<Record<Process, string>>,
 *   bytes?: number,
 *   example?: string,
 *   formerly?: string,
 *   formerlySet?: "both" | "old",
 *   platforms?: Record<string, false | Partial<EnvVar>>,
 * }} EnvVar
 *
 * `formerly`: the variable's name before a rename. The app reads the old name too
 * (LEGACY_ENV_NAMES in packages/config), accepts both names set to the same value (with a
 * warning) and refuses to start when they differ, so the generator adds an upgrade note to each
 * platform's template / README block.
 *
 * `formerlySet` (A-2 FIX, one minor release; usually per platform): which names the template
 * itself sets. Unset = the new name only. `both` = the new and the old name with the SAME value
 * (only where both can be fed from one generated value), so an older image — which reads only the
 * old name and, finding no key, generates a new one — still finds the key. `old` = the old name
 * only, for a platform that generates one random value per name (Render): two names there would
 * be two different keys.
 */

/** @type {EnvVar[]} */
export const ENV = [
  // --- identity and wiring ---------------------------------------------------------------
  {
    name: "APP_ENV",
    description:
      "prod: https BASE_URL, MAIL_FROM and SMTP_URL become mandatory; SMTP over TLS, a METRICS_TOKEN for /metrics, and a virus scanner or AV_ACCEPT_UNSCANNED.",
    kind: "literal",
    processes: ["web", "worker"],
    value: "prod",
  },
  {
    name: "BASE_URL",
    description: "Public https URL of the portal (the platform hostname or your own domain).",
    kind: "baseUrl",
    processes: ["web", "worker"],
    required: true,
    example: "https://investors.example.com",
  },
  {
    name: "DATABASE_URL",
    description: "Postgres connection string (the platform's managed Postgres).",
    kind: "database",
    processes: ["web", "worker"],
    secret: true,
    required: true,
  },
  {
    name: "ROLES",
    description: "api,web on the web process, worker on the worker process.",
    kind: "literal",
    processes: ["web", "worker"],
    value: { web: "api,web", worker: "worker" },
    platforms: {
      // One all-in-one process on the VPS.
      coolify: { processes: ["web"], value: { web: "api,web,worker" } },
      // Fly's [env] is app-wide, so the roles travel as `serve --roles …` in [processes].
      fly: false,
    },
  },
  {
    name: "WORKER_MODE",
    description: "external on the web process: a separate worker process runs the jobs.",
    kind: "literal",
    processes: ["web"],
    value: { web: "external" },
    platforms: {
      coolify: { value: { web: "embedded" } },
      // App-wide on Fly, and ROLES=worker with WORKER_MODE=external is rejected by config.
      fly: false,
    },
  },
  {
    name: "MIGRATE_ON_START",
    description: "Off: the platform's migrate step runs migrations once per deploy.",
    kind: "literal",
    processes: ["web", "worker"],
    value: "false",
  },
  {
    name: "TRUST_PROXY",
    description: "The platform's router terminates TLS and sets X-Forwarded-*.",
    kind: "literal",
    processes: ["web", "worker"],
    value: "true",
  },
  {
    // E2.10 F-07: the proxies append to X-Forwarded-For, so its leftmost entry is whatever the
    // client sent. Read the single-valued header each edge overwrites instead. Traefik (Coolify)
    // and the shipped Caddy replace X-Forwarded-For for untrusted clients, so the default
    // (TRUST_PROXY_HOPS=1, the rightmost entry) is right there.
    // Review R2-07: Fly-Client-IP is documented as edge-set. Railway's X-Real-IP and Render's
    // True-Client-IP (Cloudflare) are overwritten per the platforms' staff/community statements,
    // not their documentation; the READMEs carry a one-curl forged-header check to run after deploy.
    name: "CLIENT_IP_HEADER",
    description: "Header the platform's edge sets to the client address (overwritten per request).",
    kind: "literal",
    processes: ["web", "worker"],
    value: "X-Real-IP",
    platforms: {
      fly: { value: "Fly-Client-IP" },
      // Render's edge is Cloudflare, which sets True-Client-IP.
      render: { value: "True-Client-IP" },
      coolify: false,
    },
  },
  {
    name: "TENANCY_MODE",
    description: "single: one workspace. multi routes workspaces by host (custom domains).",
    kind: "literal",
    processes: ["web", "worker"],
    value: "single",
  },
  {
    name: "CUSTOM_DOMAIN_DRIVER",
    description:
      "manual: the platform issues certificates for domains you add there; the app only verifies DNS.",
    kind: "literal",
    processes: ["web", "worker"],
    value: "manual",
    platforms: { "coolify-caddy": { value: "caddy-ask" } },
  },
  {
    name: "ROBOTS",
    description: "noindex keeps the investor portal out of search engines.",
    kind: "literal",
    processes: ["web", "worker"],
    value: "noindex",
  },
  {
    name: "LOG_LEVEL",
    description: "trace|debug|info|warn|error.",
    kind: "literal",
    processes: ["web", "worker"],
    value: "info",
  },

  // --- secrets ---------------------------------------------------------------------------
  {
    name: "FUNDROOM_SECRET_KEY",
    description:
      "Master key (256-bit). Generated once; back it up — losing it loses every encrypted field.",
    // The name before the FundRoom rename (A-2). The app still reads it (and warns); the
    // templates print a per-platform upgrade note so an existing install keeps its key.
    formerly: "SEEDHOST_SECRET_KEY",
    platforms: {
      // Coolify feeds both names from one generated value (SERVICE_REALBASE64_SEEDHOSTKEY).
      coolify: { formerlySet: "both" },
      // Render's generateValue makes one random value per name and an env group cannot reference
      // another variable, so for this minor release the Blueprint keeps generating the old name.
      render: { formerlySet: "old" },
    },
    kind: "generate",
    processes: ["web", "worker"],
    secret: true,
    required: true,
    bytes: 32,
  },
  {
    name: "SESSION_SECRET",
    description: "Session signing secret (otherwise derived from the master key).",
    kind: "generate",
    processes: ["web", "worker"],
    secret: true,
    bytes: 32,
  },
  {
    name: "SETUP_TOKEN",
    description:
      "First-run setup token, readable in the platform's variables screen instead of the logs.",
    kind: "generate",
    processes: ["web"],
    secret: true,
    bytes: 16,
  },
  {
    name: "METRICS_TOKEN",
    description: "Bearer token for /metrics; in prod /metrics is served only when one is set.",
    kind: "generate",
    processes: ["web", "worker"],
    secret: true,
    bytes: 24,
  },

  // --- documents: S3-compatible bucket ---------------------------------------------------
  {
    name: "STORAGE_DRIVER",
    description: "s3: web and worker run on separate machines and cannot share a volume.",
    kind: "literal",
    processes: ["web", "worker"],
    value: "s3",
    platforms: {
      coolify: { value: "fs" },
      "coolify-caddy": { value: "fs" },
    },
  },
  {
    name: "S3_BUCKET",
    description: "Bucket for documents.",
    kind: "prompt",
    processes: ["web", "worker"],
    example: "fundroom-documents",
    platforms: { coolify: false },
  },
  {
    name: "S3_ENDPOINT",
    description: "S3 API endpoint (R2, Tigris, B2, AWS: https://s3.<region>.amazonaws.com).",
    kind: "prompt",
    processes: ["web", "worker"],
    example: "https://<account>.r2.cloudflarestorage.com",
    platforms: {
      coolify: false,
      fly: { kind: "literal", value: "https://fly.storage.tigris.dev" },
    },
  },
  {
    name: "S3_REGION",
    description: "auto for R2/Tigris; the bucket's region on AWS.",
    kind: "literal",
    processes: ["web", "worker"],
    value: "auto",
    platforms: { coolify: false },
  },
  {
    name: "S3_ACCESS_KEY_ID",
    description: "Bucket access key.",
    kind: "prompt",
    processes: ["web", "worker"],
    secret: true,
    platforms: { coolify: false },
  },
  {
    name: "S3_SECRET_ACCESS_KEY",
    description: "Bucket secret key.",
    kind: "prompt",
    processes: ["web", "worker"],
    secret: true,
    platforms: { coolify: false },
  },

  // --- virus scanning --------------------------------------------------------------------
  {
    // E2.10 F-11: prod refuses AV_DRIVER=noop unless this says so. No PaaS here runs clamd next
    // to the app, so the acknowledgement is explicit in the template; uploads are stored
    // `skipped` and each workspace decides whether unscanned files are servable (off by default).
    name: "AV_ACCEPT_UNSCANNED",
    description:
      "No virus scanner on this platform: uploads stay unservable unless a workspace allows unscanned files. Run clamd and set AV_DRIVER=clamd + CLAMD_HOST to scan.",
    kind: "literal",
    processes: ["web", "worker"],
    value: "true",
  },

  // --- mail ------------------------------------------------------------------------------
  {
    name: "MAILER_DRIVER",
    description: "smtp here; resend|postmark|ses need their own keys (see .env.example).",
    kind: "literal",
    processes: ["web", "worker"],
    value: "smtp",
  },
  {
    name: "SMTP_URL",
    description:
      "smtps://user:pass@host:465, or smtp://…:587?requireTLS=true (required in prod; plain STARTTLS is refused).",
    kind: "prompt",
    processes: ["web", "worker"],
    secret: true,
    required: true,
    example: "smtps://user:pass@smtp.example.com:465",
  },
  {
    name: "MAIL_FROM",
    description: "Sender address (required in prod).",
    kind: "prompt",
    processes: ["web", "worker"],
    required: true,
    example: "investors@example.com",
  },
];

/**
 * Platform descriptors. `id` keys the `platforms` overrides above; `outputs` are relative to the
 * repository root. `processes` lists the processes this platform runs (Coolify: one).
 */
export const PLATFORMS = {
  render: {
    id: "render",
    title: "Render",
    processes: ["web", "worker"],
    outputs: ["deploy/render/render.yaml"],
    readme: "deploy/render/README.md",
    names: {
      web: "fundroom",
      worker: "fundroom-worker",
      database: "fundroom-db",
      group: "fundroom-shared",
    },
    // Paid instance types: the pre-deploy command (migrations) is not available on `free`.
    plans: { web: "starter", worker: "standard", database: "basic-1gb" },
    postgresMajorVersion: "18",
    databaseName: "seedhost",
    databaseUser: "seedhost",
  },
  railway: {
    id: "railway",
    title: "Railway",
    processes: ["web", "worker"],
    outputs: [],
    readme: "deploy/railway/README.md",
    // Service names as they appear in `${{<service>.VAR}}` references.
    names: { web: "web", worker: "worker", database: "Postgres" },
  },
  fly: {
    id: "fly",
    title: "Fly.io",
    processes: ["web", "worker"],
    outputs: ["deploy/fly/fly.toml"],
    readme: "deploy/fly/README.md",
    app: "fundroom",
    // [processes] group names; `app` is what `fly launch` and `fly scale` assume by default.
    groups: { web: "app", worker: "worker" },
    vm: {
      web: { size: "shared-cpu-1x", memory: "512mb" },
      worker: { size: "shared-cpu-2x", memory: "1gb" },
    },
    killTimeout: 30,
  },
  coolify: {
    id: "coolify",
    title: "Coolify (Traefik)",
    processes: ["web"],
    outputs: ["deploy/coolify/compose.coolify.yaml"],
    readme: "deploy/coolify/README.md",
  },
  "coolify-caddy": {
    id: "coolify-caddy",
    title: "Coolify (Caddy, on-demand TLS)",
    processes: ["web"],
    outputs: ["deploy/coolify/compose.coolify-caddy.yaml"],
    readme: "deploy/coolify/README.md",
  },
};

/**
 * The catalogue as one platform sees it: overrides applied, excluded entries dropped, `processes`
 * narrowed to the ones the platform runs. Coolify variants inherit `coolify` overrides first.
 *
 * @param {string} platformId
 * @returns {EnvVar[]}
 */
export function envFor(platformId) {
  const platform = PLATFORMS[platformId];
  const chain = platformId.startsWith("coolify-") ? ["coolify", platformId] : [platformId];
  /** @type {EnvVar[]} */
  const out = [];
  for (const entry of ENV) {
    let merged = { ...entry };
    let dropped = false;
    for (const id of chain) {
      const override = entry.platforms?.[id];
      if (override === false) dropped = true;
      else if (override !== undefined) {
        dropped = false;
        merged = { ...merged, ...override };
      }
    }
    if (dropped) continue;
    const processes = merged.processes.filter((p) => platform.processes.includes(p));
    if (processes.length === 0) continue;
    const { platforms: _ignored, ...rest } = merged;
    out.push({ ...rest, processes });
  }
  return out;
}

/**
 * The literal value of `entry` for `process`.
 *
 * @param {EnvVar} entry
 * @param {Process} process
 * @returns {string | undefined}
 */
export function literalFor(entry, process) {
  if (typeof entry.value === "string") return entry.value;
  return entry.value?.[process];
}
