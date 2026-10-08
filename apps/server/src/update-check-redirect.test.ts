import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUpdateCheck } from "./container.js";

/*
 * The update check follows no redirects (E2.9 review L1): the guard would follow an https → http
 * hop, so an https-only `UPDATE_CHECK_URL` would only protect the first request.
 */
const INDEX = JSON.stringify({
  schemaVersion: 1,
  latest: "1.0.0",
  releases: [
    {
      version: "1.0.0",
      date: "2026-10-01",
      url: "https://example.com/r/1.0.0",
      security: false,
      summary: "Release 1.0.0",
    },
  ],
});

let origin = "";
const hits: string[] = [];
const server = createServer((req, res) => {
  hits.push(req.url ?? "");
  if (req.url === "/moved.json") {
    res.writeHead(301, { location: `${origin}/index.json` }).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(INDEX);
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function check(path: string) {
  return createUpdateCheck(
    {
      UPDATE_CHECK: true,
      UPDATE_CHECK_URL: `${origin}${path}`,
      OUTBOUND_HTTP_ALLOW_PRIVATE: false,
      OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS: ["127.0.0.1"],
    },
    { log: () => {} },
  );
}

describe("createUpdateCheck", () => {
  it("reads the index directly but refuses to follow a redirect", async () => {
    const direct = check("/index.json");
    try {
      expect((await direct.checker.check()).status).not.toBe("error");
    } finally {
      await direct.close();
    }
    hits.length = 0;
    const moved = check("/moved.json");
    try {
      expect((await moved.checker.check()).status).toBe("error");
      expect(hits).toEqual(["/moved.json"]);
    } finally {
      await moved.close();
    }
  });
});
