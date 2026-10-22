import { connect, createServer, type Server, Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAMD_MAX_DEADLINE_MS,
  createClamdScanner,
  parseClamdReply,
  parseClamdVersion,
  scanDeadlineMs,
} from "./clamd-scanner.js";

describe("parseClamdReply", () => {
  it("maps OK / FOUND / ERROR", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ verdict: "clean" });
    expect(parseClamdReply("stream: Eicar-Test-Signature FOUND\0")).toEqual({
      verdict: "infected",
      detail: "Eicar-Test-Signature",
    });
    expect(parseClamdReply("INSTREAM size limit exceeded. ERROR\0")).toEqual({
      verdict: "error",
      reason: "too_large",
      retryable: false,
      detail: "INSTREAM size limit exceeded. ERROR",
    });
    expect(parseClamdReply("")).toEqual({
      verdict: "error",
      reason: "unavailable",
      retryable: true,
      detail: "empty reply",
    });
  });

  it("reads Heuristics.Limits.Exceeded as not scanned in full, not infected", () => {
    expect(parseClamdReply("stream: Heuristics.Limits.Exceeded.MaxFileSize FOUND\0")).toEqual({
      verdict: "error",
      reason: "partial",
      retryable: false,
      detail: "Heuristics.Limits.Exceeded.MaxFileSize",
    });
  });
});

describe("parseClamdVersion", () => {
  it("reads engine, signature version and date (UTC)", () => {
    expect(parseClamdVersion("ClamAV 1.4.2/27431/Tue Oct 21 08:00:00 2026\0", "e")).toEqual({
      engine: "e",
      version: "1.4.2",
      signatureVersion: "27431",
      signatureDate: new Date("2026-10-21T08:00:00Z"),
    });
    expect(parseClamdVersion("ClamAV 1.4.2", "e")).toEqual({ engine: "e", version: "1.4.2" });
    expect(parseClamdVersion("nonsense", "e")).toBeNull();
  });
});

describe("scanDeadlineMs", () => {
  it("adds time per byte and caps at 20 minutes", () => {
    expect(scanDeadlineMs(120_000, 0, 10 ** 9)).toBe(120_000);
    expect(scanDeadlineMs(120_000, 1_000_000, 10_000_001)).toBe(131_000);
    expect(scanDeadlineMs(120_000, 1_000_000, undefined)).toBe(120_000);
    expect(scanDeadlineMs(120_000, 1, 10 ** 9)).toBe(CLAMD_MAX_DEADLINE_MS);
    expect(CLAMD_MAX_DEADLINE_MS).toBe(20 * 60 * 1000);
  });
});

/* ------------------------------------------------------------------------------------------- */
/* Against fake clamd servers                                                                  */
/* ------------------------------------------------------------------------------------------- */

type Handler = (socket: Socket) => void;

const servers: Server[] = [];
const accepted: Socket[] = [];
let rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);

beforeEach(() => {
  rejections = [];
  process.on("unhandledRejection", onRejection);
});

afterEach(async () => {
  // Let any late rejection surface before asserting none happened.
  await new Promise((r) => setTimeout(r, 20));
  process.off("unhandledRejection", onRejection);
  expect(rejections).toEqual([]);
  for (const s of accepted.splice(0)) s.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function fake(handler: Handler): Promise<{ port: number; server: Server }> {
  const server = createServer((socket) => {
    accepted.push(socket);
    socket.on("error", () => {});
    handler(socket);
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as { port: number }).port, server };
}

/** Parses INSTREAM framing; calls `onEnd` after the zero-length chunk, `onBytes` per chunk. */
function instream(
  onEnd: (socket: Socket, received: number) => void,
  onBytes?: (socket: Socket, received: number) => void,
): Handler {
  return (socket) => {
    let buf = Buffer.alloc(0);
    let received = 0;
    let started = false;
    socket.on("data", (data: Buffer) => {
      buf = Buffer.concat([buf, data]);
      if (!started) {
        if (buf.length < 10) return;
        expect(buf.subarray(0, 10).toString()).toBe("zINSTREAM\0");
        buf = buf.subarray(10);
        started = true;
      }
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          onEnd(socket, received);
          return;
        }
        if (buf.length < 4 + len) return;
        buf = buf.subarray(4 + len);
        received += len;
        onBytes?.(socket, received);
        if (socket.destroyed) return;
      }
    });
  };
}

function command(reply: (cmd: string) => string): Handler {
  return (socket) => {
    let text = "";
    socket.on("data", (d: Buffer) => {
      text += d.toString();
      if (text.includes("\0")) socket.end(`${reply(text.slice(1, text.indexOf("\0")))}\0`);
    });
  };
}

/** A stream body that records whether it was cancelled. */
function trackedStream(totalBytes: number, chunk = 64 * 1024) {
  const state = { cancelled: false, pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= totalBytes) return controller.close();
      const n = Math.min(chunk, totalBytes - state.pulled);
      state.pulled += n;
      controller.enqueue(new Uint8Array(n));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

const scanner = (port: number, extra: Parameters<typeof createClamdScanner>[0] | object = {}) =>
  createClamdScanner({ host: "127.0.0.1", port, chunkBytes: 64 * 1024, ...extra });

describe("clamd scanner over TCP", () => {
  it("answers clean, and sends every byte", async () => {
    let got = -1;
    const { port } = await fake(
      instream((s, n) => {
        got = n;
        s.end("stream: OK\0");
      }),
    );
    const { body, state } = trackedStream(300_000);
    const r = await scanner(port).scan({ body, size: 300_000 });
    expect(r).toEqual({ verdict: "clean", engine: `clamd@127.0.0.1:${port}` });
    expect(got).toBe(300_000);
    expect(state.cancelled).toBe(false);
  });

  it("answers infected with the signature", async () => {
    const { port } = await fake(instream((s) => s.end("stream: Eicar-Test-Signature FOUND\0")));
    const r = await scanner(port).scan({ body: new Uint8Array(68) });
    expect(r).toMatchObject({ verdict: "infected", detail: "Eicar-Test-Signature" });
  });

  it("answers partial (not infected) for Heuristics.Limits.Exceeded", async () => {
    const { port } = await fake(
      instream((s) => s.end("stream: Heuristics.Limits.Exceeded.MaxScanSize FOUND\0")),
    );
    const r = await scanner(port).scan({ body: new Uint8Array(10) });
    expect(r).toMatchObject({ verdict: "error", reason: "partial", retryable: false });
  });

  it("keeps the size-limit reply when clamd answers mid-stream and closes", async () => {
    const { port } = await fake(
      instream(
        () => {},
        (s, n) => {
          if (n >= 256 * 1024 && s.writable) {
            // clamd's reply, then it hangs up while the client is still sending. (A hang-up that
            // resets the connection can destroy the reply in the client's kernel before it is
            // read; that race is why AV_MAX_SCAN_BYTES refuses such files before sending.)
            s.end("INSTREAM size limit exceeded. ERROR\0");
          }
        },
      ),
    );
    const { body, state } = trackedStream(16 * 1024 * 1024);
    const r = await scanner(port).scan({ body });
    expect(r).toMatchObject({
      verdict: "error",
      reason: "too_large",
      retryable: false,
      detail: "INSTREAM size limit exceeded. ERROR",
    });
    // The write loop stopped: nowhere near 16 MiB was read from the body.
    expect(state.pulled).toBeLessThan(16 * 1024 * 1024);
    expect(state.cancelled).toBe(true);
  });

  it("times out a daemon that never reads or replies, and releases the body", async () => {
    const { port } = await fake((s) => s.pause());
    const { body, state } = trackedStream(64 * 1024 * 1024);
    const started = Date.now();
    const r = await scanner(port, { timeoutMs: 300 }).scan({ body });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r).toMatchObject({ verdict: "error", reason: "timeout", retryable: true });
    expect(state.cancelled).toBe(true);
  });

  it("reports a connection reset mid-stream as unavailable (retry)", async () => {
    const { port } = await fake(
      instream(
        () => {},
        (s, n) => {
          if (n >= 128 * 1024) s.resetAndDestroy();
        },
      ),
    );
    const { body, state } = trackedStream(16 * 1024 * 1024);
    const r = await scanner(port).scan({ body });
    expect(r).toMatchObject({ verdict: "error", reason: "unavailable", retryable: true });
    expect(state.cancelled).toBe(true);
  });

  it("gives up on a connect that never completes", async () => {
    const sockets: Socket[] = [];
    const blackHole = (() => {
      const s = new Socket(); // never connected: no connect, no error
      sockets.push(s);
      return s;
    }) as unknown as typeof connect;
    const s = createClamdScanner({ host: "clamav", connect: blackHole, connectTimeoutMs: 100 });
    const { body, state } = trackedStream(1024);
    const r = await s.scan({ body, size: 1024 });
    expect(r).toMatchObject({ verdict: "error", reason: "unavailable", retryable: true });
    expect(r.detail).toContain("connect");
    expect(state.cancelled).toBe(true);
    await expect(s.healthCheck()).rejects.toThrow(/connect/u);
    await expect(s.info()).resolves.toBeNull();
    expect(sockets).toHaveLength(3);
    for (const sock of sockets) expect(sock.destroyed).toBe(true);
  });

  it("ends the exchange when the caller's signal aborts mid-stream (unavailable, retry)", async () => {
    const { port } = await fake((s) => s.pause()); // reads nothing, never replies
    const { body, state } = trackedStream(64 * 1024 * 1024);
    const controller = new AbortController();
    const started = Date.now();
    const pending = scanner(port, { timeoutMs: 60_000 }).scan({ body, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const r = await pending;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r).toMatchObject({ verdict: "error", reason: "unavailable", retryable: true });
    expect(r.detail).toContain("aborted");
    expect(state.cancelled).toBe(true);
  });

  it("does not dial at all for an already aborted signal", async () => {
    let dialled = 0;
    const dial = (() => {
      dialled++;
      return new Socket();
    }) as unknown as typeof connect;
    const controller = new AbortController();
    controller.abort();
    const { body, state } = trackedStream(1024);
    const r = await createClamdScanner({ host: "clamav", connect: dial }).scan({
      body,
      signal: controller.signal,
    });
    expect(r).toMatchObject({ verdict: "error", reason: "unavailable", retryable: true });
    expect(dialled).toBe(0);
    expect(state.cancelled).toBe(true);
  });

  it("classifies a dial that throws as unavailable and releases the body", async () => {
    const dial = (() => {
      throw new Error("EMFILE: too many open files");
    }) as unknown as typeof connect;
    const { body, state } = trackedStream(1024);
    const r = await createClamdScanner({ host: "clamav", connect: dial }).scan({
      body,
      size: 1024,
    });
    expect(r).toMatchObject({ verdict: "error", reason: "unavailable", retryable: true });
    expect(r.detail).toContain("EMFILE");
    expect(r.detail).not.toContain("reading the file");
    expect(state.cancelled).toBe(true);
  });

  it("refuses an input above maxScanBytes before any I/O", async () => {
    let dialled = 0;
    const counting = ((...args: Parameters<typeof connect>) => {
      dialled++;
      return connect(...args);
    }) as typeof connect;
    const s = createClamdScanner({ host: "clamav", connect: counting, maxScanBytes: 1_048_576 });
    expect(s.maxScanBytes).toBe(1_048_576);
    const { body, state } = trackedStream(2_000_000);
    const r = await s.scan({ body, size: 2_000_000, source: "data-room" });
    expect(r).toMatchObject({ verdict: "error", reason: "too_large", retryable: false });
    expect(dialled).toBe(0);
    expect(state.cancelled).toBe(true);
  });

  it("stops at maxScanBytes when the size was not declared", async () => {
    const { port } = await fake(instream((s) => s.end("stream: OK\0")));
    const { body, state } = trackedStream(4 * 1024 * 1024);
    const r = await scanner(port, { maxScanBytes: 1_048_576 }).scan({ body });
    expect(r).toMatchObject({ verdict: "error", reason: "too_large", retryable: false });
    expect(state.cancelled).toBe(true);
  });

  it("answers PING and VERSION", async () => {
    const { port } = await fake(
      command((cmd) =>
        cmd === "PING"
          ? "PONG"
          : cmd === "VERSION"
            ? "ClamAV 1.4.2/27431/Tue Oct 21 08:00:00 2026"
            : "?",
      ),
    );
    const s = scanner(port);
    await expect(s.healthCheck()).resolves.toBeUndefined();
    expect(await s.info()).toEqual({
      engine: `clamd@127.0.0.1:${port}`,
      version: "1.4.2",
      signatureVersion: "27431",
      signatureDate: new Date("2026-10-21T08:00:00Z"),
    });
  });

  it("fails PING on a silent daemon within the probe timeout and closes the socket", async () => {
    // Reads (so it sees the client's FIN) but never answers.
    const { port, server } = await fake((sock) => sock.resume());
    const s = scanner(port, { timeoutMs: 200 });
    await expect(s.healthCheck()).rejects.toThrow(/timed out/u);
    await expect(s.info()).resolves.toBeNull();
    const deadline = Date.now() + 2000;
    let open = 1;
    while (Date.now() < deadline) {
      open = await new Promise<number>((r) => server.getConnections((_e, n) => r(n)));
      if (open === 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(open).toBe(0);
  });

  it("fails PING on a refused connection", async () => {
    const { port, server } = await fake(() => {});
    await new Promise((r) => server.close(r));
    servers.splice(servers.indexOf(server), 1);
    await expect(scanner(port).healthCheck()).rejects.toThrow(/ECONNREFUSED/u);
    expect(await scanner(port).scan({ body: new Uint8Array(1) })).toMatchObject({
      verdict: "error",
      reason: "unavailable",
      retryable: true,
    });
  });
});
