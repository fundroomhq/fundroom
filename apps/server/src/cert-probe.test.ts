import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTlsServer, type Server as TlsServer } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCertProbe } from "./cert-probe.js";

/*
 * The health page's certificate reader against a real `node:tls` server with a self-signed
 * certificate generated per run (no key material is committed). The name `probe.test` is mapped
 * to 127.0.0.1 through the injected lookup and exempted through `allowedPrivateHosts`, exactly the
 * way an operator's `OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS` would.
 */
let tls: TlsServer;
let silent: NetServer;
let tlsPort = 0;
let silentPort = 0;
let cert = "";
let connections = 0;
let silentConnections = 0;

const localhost = async () => ["127.0.0.1"];

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "fundroom-cert-probe-"));
  writeFileSync(
    join(dir, "req.cnf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=probe.test\nO=Seed Test CA\n[v3]\nsubjectAltName=DNS:probe.test\nbasicConstraints=critical,CA:TRUE\n",
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "30",
      "-config",
      join(dir, "req.cnf"),
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(join(dir, "cert.pem"), "utf8");
  tls = createTlsServer({ key: readFileSync(join(dir, "key.pem")), cert }, (socket) => {
    socket.end();
  });
  // TCP connections, not completed connections: the probe hangs up as soon as it has the cert.
  tls.on("connection", () => {
    connections++;
  });
  await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));
  tlsPort = (tls.address() as { port: number }).port;
  // Accepts TCP and never answers the ClientHello: the black-holed host the timeout exists for.
  silent = createNetServer(() => {
    silentConnections++;
  });
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  silentPort = (silent.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise((r) => tls?.close(r));
  silent?.close();
});

describe("createCertProbe", () => {
  it("reads a self-signed certificate it cannot verify and says so", async () => {
    const probe = createCertProbe({
      port: tlsPort,
      lookup: localhost,
      allowedPrivateHosts: ["probe.test"],
    });
    const [r] = await probe.probe(["probe.test"]);
    expect(r?.status).toBe("invalid");
    expect(r?.error).toMatch(/SELF_SIGNED/u);
    expect(r?.issuer).toContain("Seed Test CA");
    const days = ((r?.expiresAt?.getTime() ?? 0) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(28);
    expect(days).toBeLessThan(31);
  });

  it("is valid when the chain verifies, expired when the clock is past notAfter", async () => {
    const valid = createCertProbe({
      port: tlsPort,
      lookup: localhost,
      allowedPrivateHosts: ["probe.test"],
      ca: cert,
    });
    expect((await valid.probe(["probe.test"]))[0]).toMatchObject({ status: "valid", error: null });
    const later = createCertProbe({
      port: tlsPort,
      lookup: localhost,
      allowedPrivateHosts: ["probe.test"],
      ca: cert,
      now: () => new Date(Date.now() + 60 * 86_400_000),
    });
    const [r] = await later.probe(["probe.test"]);
    expect(r?.status).toBe("expired");
    expect(r?.expiresAt).toBeInstanceOf(Date);
  });

  it("caches per hostname and shares one connection between concurrent probes", async () => {
    const probe = createCertProbe({
      port: tlsPort,
      lookup: localhost,
      allowedPrivateHosts: ["probe.test"],
    });
    const before = connections;
    await Promise.all([probe.probe(["probe.test"]), probe.probe(["probe.test", "PROBE.test"])]);
    await probe.probe(["probe.test"]);
    expect(connections - before).toBe(1);
  });

  it("never connects to a private address unless the name is allow-listed", async () => {
    const before = connections;
    const probe = createCertProbe({ port: tlsPort, lookup: localhost });
    const [r] = await probe.probe(["probe.test"]);
    expect(r).toMatchObject({ status: "unreachable", error: "resolves to a blocked address" });
    // An internal-only name is refused before DNS.
    const [internal] = await createCertProbe({ port: tlsPort, lookup: localhost }).probe([
      "db.internal",
    ]);
    expect(internal).toMatchObject({ status: "unreachable", error: "hostname is not allowed" });
    expect(connections).toBe(before);
  });

  it("gives up after the timeout on a host that never completes the handshake", async () => {
    const probe = createCertProbe({
      port: silentPort,
      lookup: localhost,
      allowedPrivateHosts: ["probe.test"],
      timeoutMs: 300,
    });
    const started = Date.now();
    const [r] = await probe.probe(["probe.test"]);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r?.status).toBe("unreachable");
    expect(r?.error).toMatch(/within 300 ms/u);
    expect(silentConnections).toBeGreaterThan(0);
  });

  it("reports a DNS failure without throwing", async () => {
    const probe = createCertProbe({
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect((await probe.probe(["nowhere.example.com"]))[0]).toMatchObject({
      status: "unreachable",
      error: "DNS lookup failed",
    });
  });
});
