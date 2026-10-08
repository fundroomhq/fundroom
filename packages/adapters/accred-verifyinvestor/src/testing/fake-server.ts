import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createFakeVerifyInvestor,
  type FakeVerifyInvestorControl,
  type FakeVerifyInvestorOptions,
} from "./fake-vendor.js";

/**
 * A real HTTP fake of the VerifyInvestor.com API v1 endpoints the adapter calls, on 127.0.0.1 with
 * an ephemeral port — for end-to-end tests through the real SSRF guard (allow-list 127.0.0.1 via
 * ACCREDITATION_ALLOW_PRIVATE_HOSTS). Pass `url` as the adapter's `deps.apiBaseUrl` (the adapter
 * appends `/api/v1`). `vendor.apiToken` / `vendor.webhookSecret` are what the connection must hold.
 */
export async function startFakeVerifyInvestor(
  options: FakeVerifyInvestorOptions = {},
): Promise<{ url: string; vendor: FakeVerifyInvestorControl; close(): Promise<void> }> {
  const fake = createFakeVerifyInvestor(options);
  let origin = "";

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        try {
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) {
            if (v === undefined) continue;
            headers.set(k, Array.isArray(v) ? v.join(", ") : v);
          }
          const method = req.method ?? "GET";
          const body = Buffer.concat(chunks);
          const request = new Request(`${origin}${req.url ?? "/"}`, {
            method,
            headers,
            ...(method === "GET" || method === "HEAD" || body.byteLength === 0 ? {} : { body }),
          });
          const answer = await fake.handle(request);
          const out = Buffer.from(await answer.arrayBuffer());
          const outHeaders: Record<string, string> = {};
          answer.headers.forEach((value, key) => {
            outHeaders[key] = value;
          });
          outHeaders["content-length"] = String(out.byteLength);
          res.writeHead(answer.status, outHeaders);
          res.end(out);
        } catch {
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"fake verifyinvestor crashed"}');
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;

  return {
    url: origin,
    vendor: fake.vendor,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
