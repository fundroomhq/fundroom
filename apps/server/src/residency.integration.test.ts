import { createWorkspace } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryESignAdapter } from "@fundroom/esign/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { DirectoryMove, DirectoryPort } from "@fundroom/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { bearer, mintTestApiKey } from "./test/api-keys.js";
import {
  type Actor,
  type ErrorBody,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
} from "./test/esign-harness.js";

/*
 * `GET /api/v1/residency` and the residency merge fields (E3.11, ADR-0059; owner D).
 *
 * Two servers over ONE database: `declared` runs with DATA_REGION=eu (+ label, jurisdiction,
 * BACKUP_LOCATION), Postmark as the mailer, Cloudflare for SaaS custom domains and a Sentry EU
 * DSN; `plain` (API role only) declares nothing and uses SMTP. Both serve the same workspaces, so
 * any difference in the answers is the configuration's alone.
 *
 *  - who may read it: `compliance.read` staff (owner/admin/legal) 200; other staff 403; investors
 *    404; API keys 401 (not key-callable); anonymous 401;
 *  - declared vs undeclared region (components, flags, sub-processors by config);
 *  - a vendor a workspace connected itself (e-sign) shows as `scope: workspace` for THAT
 *    workspace only;
 *  - the DPA preview renders the region, the annex table and the sub-processor rows — and says
 *    plainly when no region is declared;
 *  - nothing secret (DSN key, Cloudflare token) reaches the response;
 *  - a relocation in flight comes from the directory (shared mode), and a directory outage
 *    degrades to `relocation: null`, not a 5xx.
 */
let pg: TestPostgres;
let declared: RunningServer;
let plain: RunningServer;
let mailer: MemoryMailer;
const mem = createMemoryESignAdapter("docuseal");
const h = harness(
  () => declared,
  () => mailer,
);
const { request, member } = h;

const DSN_KEY = "sentrypublickey0123456789abcdef";
const SMTP_URL_PUBLIC = "smtp://apikey:SG.smtpsecretpass@smtp.sendgrid.net:587";
const SMTP_RELAY = "Email relay (SMTP, not identified)";
const SLACK_WEBHOOKS = "Slack Technologies, LLC (incoming webhooks)";
const GOOGLE_SHEETS = "Google LLC (Google Sheets API)";
const CF_TOKEN = "cf-token-residency-secret-9876";
const TOKEN = "docuseal-token-abcd1234";

let acmeId: string;
let globexId: string;
let owner: Actor;
let counsel: Actor;
let editor: Actor;
let ada: Actor;
let globexOwner: Actor;

interface Residency {
  region: { code: string; label: string; jurisdiction: string | null } | null;
  declared: "operator";
  cellId: string | null;
  components: {
    component: string;
    location: string | null;
    jurisdiction: string | null;
    inRegion: boolean | null;
  }[];
  subProcessors: {
    name: string;
    purpose: string;
    location: string;
    jurisdiction: string;
    transferMechanism: string | null;
    dpaUrl: string | null;
    certifications: string[];
    scope: "deployment" | "workspace";
    outsideRegion: boolean | null;
  }[];
  relocation: { state: string; targetRegion: string | null; requestedAt: string } | null;
}

/** Sets a workspace's holds as the host actor (holds are pinned against tenant actors). */
async function setHolds(workspaceId: string, holds: string[]): Promise<void> {
  const client = await pg.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_kind', 'host', true)");
    await client.query("UPDATE core.workspace SET holds = $2::text[] WHERE id = $1", [
      workspaceId,
      holds,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  plain.container.resolver.invalidate();
  declared.container.resolver.invalidate();
}

async function residency(slug: string, cookie: string, server?: RunningServer) {
  const res = await request(slug, "/api/v1/residency", {
    cookie,
    ...(server === undefined ? {} : { server }),
  });
  return { status: res.status, text: await res.text() };
}

async function read(slug: string, cookie: string, server?: RunningServer): Promise<Residency> {
  const { status, text } = await residency(slug, cookie, server);
  expect(status, text).toBe(200);
  return JSON.parse(text) as Residency;
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const secrets = freshSecrets(pg.connectionString);
  declared = await startServer({
    config: esignTestConfig(secrets, {
      DATA_REGION: "eu",
      DATA_REGION_LABEL: "European Union (Frankfurt, Germany)",
      DATA_REGION_JURISDICTION: "eu",
      BACKUP_LOCATION: "Hetzner Storage Box, Falkenstein (Germany)",
      MAILER_DRIVER: "postmark",
      POSTMARK_SERVER_TOKEN: "postmark-server-token-secret",
      MAIL_FROM: "no-reply@portal.example.test",
      CUSTOM_DOMAIN_DRIVER: "cloudflare-saas",
      CLOUDFLARE_API_TOKEN: CF_TOKEN,
      CLOUDFLARE_ZONE_ID: "023e105f4ecef8ad9ca31a8372d0c353",
      // Accepted by config but consumed by nothing: must NOT appear as a component (R3-6).
      ERROR_REPORTING_DSN: `https://${DSN_KEY}@o12345.ingest.de.sentry.io/678`,
      // An operator-run scanner next to the app (single-label service name).
      AV_DRIVER: "clamd",
      CLAMD_HOST: "clamav",
    }),
    logger: createLogger({ level: "error" }),
    mailer,
    esignAdapters: { docuseal: mem.definition },
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  plain = await startServer({
    // A PUBLIC SMTP relay: a third party the software cannot name (R3-2).
    config: esignTestConfig(secrets, { ROLES: "api", SMTP_URL: SMTP_URL_PUBLIC }),
    logger: createLogger({ level: "error" }),
    mailer,
    esignAdapters: { docuseal: mem.definition },
    listenEnabled: false,
    migrate: false,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(declared.container.db, { slug: "acme", name: "Acme" })).id;
  globexId = (await createWorkspace(declared.container.db, { slug: "globex", name: "Globex" })).id;
  owner = await member("acme", acmeId, "owner@acme.test", "staff", "owner");
  counsel = await member("acme", acmeId, "counsel@acme.test", "staff", "legal");
  editor = await member("acme", acmeId, "editor@acme.test", "staff", "editor");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  globexOwner = await member("globex", globexId, "owner@globex.test", "staff", "owner");

  // acme connects an e-sign vendor itself; globex does not.
  const put = await request("acme", "/api/v1/esign/connection", {
    method: "PUT",
    cookie: owner.cookie,
    body: JSON.stringify({ driver: "docuseal", credentials: { apiToken: TOKEN } }),
  });
  expect(put.status).toBe(200);
  // Module egress: acme posts alerts to a Slack incoming webhook (notify); globex reads metrics
  // from a Google Sheet (metrics). Rows written directly: the vendors are never called here.
  await pg.pool.query(
    `INSERT INTO notify.channel (workspace_id, kind, name, url_enc, url_hint)
     VALUES ($1, 'slack', 'alerts', '\\x00'::bytea, 'abcd')`,
    [acmeId],
  );
  await pg.pool.query(
    `INSERT INTO notify.channel (workspace_id, kind, name, url_enc, url_hint, enabled)
     VALUES ($1, 'slack', 'off', '\\x00'::bytea, 'efgh', false)`,
    [globexId],
  );
  await pg.pool.query(
    `INSERT INTO metrics.sheet_connection
       (workspace_id, spreadsheet_id, range, credential_enc, service_account_email)
     VALUES ($1, 'sheet-1', 'A1:C9', '\\x00'::bytea, 'svc@project.iam.gserviceaccount.com')`,
    [globexId],
  );
}, 240_000);

afterAll(async () => {
  await plain?.stop();
  await declared?.stop();
  await pg?.stop();
});

describe("who may read GET /residency", () => {
  it("compliance.read staff read it; other staff 403; investors 404; API keys and strangers 401", async () => {
    expect((await residency("acme", owner.cookie)).status).toBe(200);
    expect((await residency("acme", counsel.cookie)).status).toBe(200);
    expect((await residency("acme", editor.cookie)).status).toBe(403);
    expect((await residency("acme", ada.cookie)).status).toBe(404);

    const anon = await request("acme", "/api/v1/residency");
    expect(anon.status).toBe(401);

    const { token } = await mintTestApiKey(declared.container.db, {
      workspaceId: acmeId,
      creatorMembershipId: owner.membershipId,
      scopes: ["compliance.read"],
    });
    const keyed = await request("acme", "/api/v1/residency", { headers: bearer(token) });
    expect(keyed.status).toBe(401);
    expect((await json<ErrorBody>(keyed)).error.reason).toBe("api_key_not_allowed");
  });

  it("a member of another workspace cannot read acme's", async () => {
    expect((await residency("acme", globexOwner.cookie)).status).not.toBe(200);
  });
});

describe("a declared region", () => {
  it("reports the operator-declared region and where each component is", async () => {
    const body = await read("acme", owner.cookie);
    expect(body.region).toEqual({
      code: "eu",
      label: "European Union (Frankfurt, Germany)",
      jurisdiction: "eu",
    });
    expect(body.declared).toBe("operator");
    expect(body.cellId).toBeNull(); // CONTROL_PLANE off
    const by = Object.fromEntries(body.components.map((c) => [c.component, c]));
    expect(body.components.map((c) => c.component)).toEqual([
      "database",
      "jobs",
      "search",
      "analytics",
      "objectStorage",
      "backups",
      "email",
      "virusScan",
    ]);
    for (const cell of ["database", "jobs", "search", "analytics", "objectStorage", "virusScan"]) {
      expect(by[cell]).toMatchObject({
        location: "European Union (Frankfurt, Germany)",
        jurisdiction: "eu",
        inRegion: true,
      });
    }
    expect(by["backups"]).toEqual({
      component: "backups",
      location: "Hetzner Storage Box, Falkenstein (Germany)",
      jurisdiction: null,
      inRegion: null,
    });
    expect(by["email"]).toMatchObject({
      location: "United States",
      jurisdiction: "us",
      inRegion: false,
    });
    // ERROR_REPORTING_DSN is set but nothing sends to it: no component claims a transfer.
    expect(by["errorReporting"]).toBeUndefined();
  });

  it("lists the deployment's third parties with out-of-region flags and transfer mechanisms", async () => {
    const body = await read("acme", counsel.cookie);
    const deployment = body.subProcessors.filter((s) => s.scope === "deployment");
    expect(deployment.map((s) => s.name)).toEqual([
      "Postmark (ActiveCampaign, LLC)",
      "Cloudflare, Inc.",
    ]);
    expect(deployment[0]).toMatchObject({
      jurisdiction: "us",
      outsideRegion: true,
      transferMechanism: "EU SCCs (or the EU-US Data Privacy Framework — operator to confirm)",
    });
    expect(deployment[1]).toMatchObject({ jurisdiction: "varies", outsideRegion: null });
  });

  it("never reveals a secret or an endpoint", async () => {
    const { text } = await residency("acme", owner.cookie);
    for (const secret of [DSN_KEY, CF_TOKEN, "o12345", "postmark-server-token-secret", TOKEN]) {
      expect(text).not.toContain(secret);
    }
    const other = await residency("acme", owner.cookie, plain);
    for (const secret of ["sendgrid", "smtpsecretpass", "clamav"]) {
      expect(other.text).not.toContain(secret);
    }
  });
});

describe("vendors a workspace connected itself", () => {
  it("appear with scope workspace only for the workspace that connected them", async () => {
    const acme = await read("acme", owner.cookie);
    const own = acme.subProcessors.filter((s) => s.scope === "workspace");
    expect(own.map((s) => s.name)).toEqual(["DocuSeal (memory)", SLACK_WEBHOOKS]);
    expect(own[0]).toMatchObject({ jurisdiction: "varies", outsideRegion: null });
    // globex: its Google Sheet, not acme's vendors, and not its own DISABLED Slack channel.
    const globex = await read("globex", globexOwner.cookie);
    expect(globex.subProcessors.filter((s) => s.scope === "workspace").map((s) => s.name)).toEqual([
      GOOGLE_SHEETS,
    ]);
  });
});

describe("no declared region", () => {
  it("answers region null and unknown flags instead of guessing", async () => {
    const body = await read("acme", owner.cookie, plain);
    expect(body.region).toBeNull();
    expect(body.components.map((c) => c.component)).toEqual([
      "database",
      "jobs",
      "search",
      "analytics",
      "objectStorage",
      "backups",
      "email",
    ]);
    for (const c of body.components) {
      if (c.component === "email") continue;
      expect(c).toMatchObject({ location: null, jurisdiction: null, inRegion: null });
    }
    // A public SMTP relay is a third party, unidentified — never "the operator's own".
    expect(body.components.find((c) => c.component === "email")).toMatchObject({
      location: "Not identified by the software",
      jurisdiction: "varies",
      inRegion: null,
    });
    expect(body.subProcessors.map((s) => [s.scope, s.name])).toEqual([
      ["deployment", SMTP_RELAY],
      ["workspace", "DocuSeal (memory)"],
      ["workspace", SLACK_WEBHOOKS],
    ]);
    for (const s of body.subProcessors) expect(s.outsideRegion).toBeNull();
  });
});

describe("the DPA preview", () => {
  interface Preview {
    preview: string;
  }

  it("renders the declared region, the data-location annex and the sub-processor rows", async () => {
    const res = await request("acme", "/api/v1/compliance/templates/dpa", {
      cookie: counsel.cookie,
    });
    expect(res.status).toBe(200);
    const { preview } = await json<Preview>(res);
    expect(preview).toContain("## Annex: Data location");
    expect(preview).toContain(
      "The operator declares that this workspace's data is hosted in **European Union (Frankfurt, Germany)** (region `eu`)",
    );
    expect(preview).toContain(
      "| Database (all records) | European Union (Frankfurt, Germany) | European Union / EEA | Yes |",
    );
    expect(preview).toContain("| Email delivery | United States | United States | **No** |");
    expect(preview).toMatch(
      /\| Postmark \(ActiveCampaign, LLC\) \| [^|]+ \| [^|]+ \| United States \(outside the declared region\) \| EU SCCs \(or the EU-US Data Privacy Framework — operator to confirm\) \|/u,
    );
    expect(preview).toContain("| Cloudflare, Inc. |");
    // Deployment scope only: a vendor one workspace connected is not in the operator's DPA.
    expect(preview).not.toContain("DocuSeal (memory)");
    expect(preview).not.toContain(SLACK_WEBHOOKS);
    expect(preview).not.toContain("{{");
  });

  it("says plainly that no region is declared rather than rendering an empty sentence", async () => {
    const res = await request("acme", "/api/v1/compliance/templates/dpa", {
      cookie: counsel.cookie,
      server: plain,
    });
    const { preview } = await json<Preview>(res);
    expect(preview).toContain(
      "**The operator has not declared a data region for this deployment.**",
    );
    expect(preview).not.toMatch(/hosted in\s*\./u);
    // The public SMTP relay is listed, with no mechanism claimed for it.
    expect(preview).toMatch(/\| Email relay \(SMTP, not identified\) \|[^\n]*\| Not stated \|/u);
  });

  it("fills workspace.dataRegion in the other templates", async () => {
    const res = await request("acme", "/api/v1/compliance/templates/privacy-notice", {
      cookie: counsel.cookie,
    });
    const { preview } = await json<Preview>(res);
    expect(preview).toContain("Data is stored in European Union (Frankfurt, Germany).");
  });

  it("lists the workspace's own vendors in its privacy notice (it is the controller there)", async () => {
    const res = await request("acme", "/api/v1/compliance/templates/privacy-notice", {
      cookie: counsel.cookie,
    });
    const { preview } = await json<Preview>(res);
    expect(preview).toContain("| DocuSeal (memory) |");
    expect(preview).toContain(`| ${SLACK_WEBHOOKS} |`);
    expect(preview).toContain("| Postmark (ActiveCampaign, LLC) |");
    const globex = await request("globex", "/api/v1/compliance/templates/privacy-notice", {
      cookie: globexOwner.cookie,
    });
    const other = (await json<Preview>(globex)).preview;
    expect(other).toContain(`| ${GOOGLE_SHEETS} |`);
    expect(other).not.toContain("DocuSeal (memory)");
  });
});

describe("a relocation in flight", () => {
  it("comes from the directory in shared mode and degrades to null when the directory fails", async () => {
    const directory = plain.container.directory as {
      -readonly [K in keyof DirectoryPort]: DirectoryPort[K];
    };
    const original = {
      mode: directory.mode,
      moves: directory.moves,
      listCells: directory.listCells,
    };
    const createdAt = new Date("2026-09-29T10:00:00.000Z");
    const seen: unknown[] = [];
    let fail = false;
    const move = {
      id: "0192f0e0-0000-7000-8000-000000000001",
      entryId: "0192f0e0-0000-7000-8000-000000000002",
      sourceWorkspaceId: acmeId,
      slug: "acme",
      sourceCellId: "default",
      targetCellId: "us-1",
      state: "exporting",
      bundle: null,
      carried: null,
      targetWorkspaceId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      error: null,
      requestedBy: "op",
      createdAt,
      updatedAt: createdAt,
    } satisfies DirectoryMove;
    try {
      Object.assign(directory, {
        mode: "shared",
        moves: {
          ...original.moves,
          list: async (filter: unknown) => {
            seen.push(filter);
            if (fail) throw new Error("directory down");
            return (filter as { workspaceId?: string }).workspaceId === acmeId ? [move] : [];
          },
        },
        listCells: async () => [
          {
            id: "us-1",
            region: "us",
            regionLabel: "United States",
            jurisdiction: "us",
            publicOrigin: "https://us.example.test",
            status: "active",
            exportPublicKey: null,
            heartbeatAt: null,
            local: false,
          },
        ],
      });
      // The REAL hold a move puts on the source workspace (R3-1): the status guard answers 423
      // to staff everywhere except the residency page, which must show the move.
      await setHolds(acmeId, ["relocation"]);
      const blocked = await request("acme", "/api/v1/compliance/templates", {
        cookie: owner.cookie,
        server: plain,
      });
      expect(blocked.status).toBe(423);
      expect((await residency("acme", editor.cookie, plain)).status).toBe(403);
      expect((await residency("acme", ada.cookie, plain)).status).toBe(404);
      const acme = await read("acme", owner.cookie, plain);
      expect(acme.relocation).toEqual({
        state: "exporting",
        targetRegion: "us",
        requestedAt: createdAt.toISOString(),
      });
      expect(seen[0]).toMatchObject({ workspaceId: acmeId });
      expect((seen[0] as { states: string[] }).states).not.toContain("switched");
      expect((await read("globex", globexOwner.cookie, plain)).relocation).toBeNull();

      // An operator (or sanctions) hold outranks relocation: the page is closed again.
      await setHolds(acmeId, ["relocation", "operator"]);
      expect((await residency("acme", owner.cookie, plain)).status).toBe(423);
      await setHolds(acmeId, ["relocation"]);

      fail = true;
      expect((await read("acme", owner.cookie, plain)).relocation).toBeNull();
    } finally {
      Object.assign(directory, original);
      await setHolds(acmeId, []);
    }
    // Local mode: no directory round trip at all.
    expect((await read("acme", owner.cookie, plain)).relocation).toBeNull();
  });
});
