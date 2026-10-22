import { connect, type Socket } from "node:net";
import {
  CLAMD_MAX_DEADLINE_MS,
  type ScanFailureReason,
  type ScannerInfo,
  type ScanResult,
  type VirusScanPort,
} from "@fundroom/ports";

/*
 * ClamAV over the clamd TCP protocol (design/02 §4 "ClamAV … clamd socket … async job").
 * INSTREAM: `zINSTREAM\0`, then `<uint32 BE length><bytes>` chunks, then a zero-length
 * chunk; the daemon answers `stream: OK\0`, `stream: <signature> FOUND\0` or
 * `<message> ERROR\0`. clamd reads at most its `StreamMaxLength` (100 MiB by default) and then
 * answers `INSTREAM size limit exceeded. ERROR` and closes; `maxScanBytes` mirrors that limit so
 * an over-limit input is refused before any byte is sent.
 *
 * Every exchange with the daemon (INSTREAM, PING, VERSION) goes through one `Exchange`: one
 * settle path for the reply, the deadline, a socket error or close, so nothing rejects twice or
 * unobserved; the write loop stops as soon as the exchange has settled (a reply arrived early, or
 * the socket failed), and the socket and the body's reader are released on every path.
 */
export interface ClamdScannerOptions {
  readonly host: string;
  /** Default 3310. */
  readonly port?: number | undefined;
  /** Base scan deadline. Default 120 s. */
  readonly timeoutMs?: number | undefined;
  /** TCP connect deadline. Default 5 s. */
  readonly connectTimeoutMs?: number | undefined;
  /**
   * Slowest throughput a scan is allowed (bytes/s). With a known size the deadline becomes
   * `timeoutMs + ceil(size / rate) s`, capped at {@link CLAMD_MAX_DEADLINE_MS}. 0 = fixed.
   */
  readonly minBytesPerSecond?: number | undefined;
  /** clamd's `StreamMaxLength`: larger inputs answer `too_large` without being sent. */
  readonly maxScanBytes?: number | null | undefined;
  /** Chunk size sent to the daemon. Default 1 MiB. */
  readonly chunkBytes?: number | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
  /** Test seam. */
  readonly connect?: typeof connect | undefined;
}

/** The longest scan deadline (defined with the port: scanning jobs expire after 30 minutes). */
export { CLAMD_MAX_DEADLINE_MS };

const PROBE_TIMEOUT_MS = 5000;

/** `timeoutMs` plus time for `size` bytes at `minBytesPerSecond`, capped at 20 minutes. */
export function scanDeadlineMs(
  timeoutMs: number,
  minBytesPerSecond: number,
  size: number | undefined,
): number {
  const extra =
    minBytesPerSecond > 0 && size !== undefined && size > 0
      ? Math.ceil(size / minBytesPerSecond) * 1000
      : 0;
  return Math.min(timeoutMs + extra, CLAMD_MAX_DEADLINE_MS);
}

const LIMITS_EXCEEDED = /^Heuristics\.Limits\.Exceeded/u;

function failure(
  reason: ScanFailureReason,
  detail: string,
): Omit<ScanResult, "engine"> & { verdict: "error" } {
  const retryable = reason === "unavailable" || reason === "timeout";
  return { verdict: "error", reason, retryable, detail };
}

export function parseClamdReply(reply: string): Omit<ScanResult, "engine"> {
  const text = reply.replace(/\0+$/u, "").trim();
  if (/\bOK$/u.test(text)) return { verdict: "clean" };
  const found = /^(?:stream: )?(.+?) FOUND$/u.exec(text);
  if (found?.[1]) {
    // `AlertExceedsMax yes`: the engine stopped at its own MaxFileSize/MaxScanSize/… limits.
    // Nothing was found; the file just could not be scanned in full. Never served, not infected.
    if (LIMITS_EXCEEDED.test(found[1])) return failure("partial", found[1]);
    return { verdict: "infected", detail: found[1] };
  }
  if (/size limit exceeded/iu.test(text)) return failure("too_large", text);
  return failure("unavailable", text || "empty reply");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `ClamAV 1.4.2/27431/Tue Oct 21 08:00:00 2026` (the date is clamd's ctime, read as UTC). */
export function parseClamdVersion(reply: string, engine: string): ScannerInfo | null {
  const text = reply.replace(/\0+$/u, "").trim();
  const m = /^ClamAV ([^/\s]+)(?:\/(\d+)(?:\/(.+))?)?$/u.exec(text);
  if (!m?.[1]) return null;
  const info: { engine: string; version: string; signatureVersion?: string; signatureDate?: Date } =
    { engine, version: m[1] };
  if (m[2]) info.signatureVersion = m[2];
  const d = /^\w{3} (\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u.exec(m[3]?.trim() ?? "");
  const month = d ? MONTHS.indexOf(d[1] as string) : -1;
  if (d && month >= 0) {
    info.signatureDate = new Date(
      Date.UTC(Number(d[6]), month, Number(d[2]), Number(d[3]), Number(d[4]), Number(d[5])),
    );
  }
  return info;
}

type Outcome =
  | { readonly ok: true; readonly reply: string }
  | { readonly ok: false; readonly reason: "unavailable" | "timeout"; readonly error: string };

/**
 * One connection and one reply. `done` never rejects and settles exactly once: on the first
 * NUL-terminated reply, the deadline, the connect timeout, a socket error, or the close.
 */
class Exchange {
  readonly done: Promise<Outcome>;
  readonly connected: Promise<boolean>;
  private settledWith: Outcome | undefined;
  private finish!: (o: Outcome) => void;
  private readonly socket: Socket;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    dial: typeof connect,
    host: string,
    port: number,
    connectTimeoutMs: number,
    deadlineMs: number,
    what: string,
  ) {
    this.done = new Promise<Outcome>((resolve) => {
      this.finish = resolve;
    });
    let out = "";
    const socket = dial({ host, port });
    this.socket = socket;
    this.connected = new Promise<boolean>((resolve) => {
      socket.once("connect", () => resolve(true));
      void this.done.then(() => resolve(false));
    });
    const connectTimer = setTimeout(
      () =>
        this.settle({
          ok: false,
          reason: "unavailable",
          error: `clamd: connect to ${host}:${port} timed out after ${connectTimeoutMs} ms`,
        }),
      connectTimeoutMs,
    );
    this.timers.push(connectTimer);
    socket.once("connect", () => clearTimeout(connectTimer));
    this.timers.push(
      setTimeout(
        () =>
          this.settle({
            ok: false,
            reason: "timeout",
            error: `clamd: ${what} timed out after ${deadlineMs} ms`,
          }),
        deadlineMs,
      ),
    );
    socket.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const end = out.indexOf("\0");
      if (end >= 0) this.settle({ ok: true, reply: out.slice(0, end) });
    });
    socket.on("error", (error) => {
      // A reply that arrived before the error (size limit, then EPIPE/ECONNRESET) wins.
      if (out.length > 0) this.settle({ ok: true, reply: out });
      else this.settle({ ok: false, reason: "unavailable", error: `clamd: ${String(error)}` });
    });
    socket.on("close", () => {
      if (out.length > 0) this.settle({ ok: true, reply: out });
      else
        this.settle({
          ok: false,
          reason: "unavailable",
          error: `clamd: connection closed before the ${what} reply`,
        });
    });
  }

  get settled(): boolean {
    return this.settledWith !== undefined;
  }

  private settle(outcome: Outcome): void {
    if (this.settledWith !== undefined) return;
    this.settledWith = outcome;
    for (const t of this.timers) clearTimeout(t);
    this.finish(outcome);
  }

  /** Resolves false once the exchange has settled or the write failed; never rejects. */
  write(data: Uint8Array): Promise<boolean> {
    if (this.settled || this.socket.destroyed) return Promise.resolve(false);
    const written = new Promise<boolean>((resolve) => {
      this.socket.write(data, (error) => resolve(!error));
    });
    return Promise.race([written, this.done.then(() => false)]);
  }

  /** Ends the exchange now (the caller's signal fired): settles `unavailable`, retryable. */
  abort(why: string): void {
    this.settle({ ok: false, reason: "unavailable", error: `clamd: ${why}` });
    this.socket.destroy();
  }

  destroy(): void {
    for (const t of this.timers) clearTimeout(t);
    this.socket.destroy();
  }
}

/** Pulls `chunkBytes`-sized chunks from a body; `close()` cancels and releases the reader. */
class ChunkSource {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  private offset = 0;
  private finished = false;

  constructor(
    private readonly body: ReadableStream<Uint8Array> | Uint8Array,
    private readonly chunkBytes: number,
  ) {
    if (!(body instanceof Uint8Array)) this.reader = body.getReader();
  }

  async next(): Promise<Uint8Array | null> {
    if (this.body instanceof Uint8Array) {
      if (this.offset >= this.body.length) return null;
      const chunk = this.body.subarray(this.offset, this.offset + this.chunkBytes);
      this.offset += chunk.length;
      return chunk;
    }
    const reader = this.reader as ReadableStreamDefaultReader<Uint8Array>;
    const pending: Uint8Array[] = [];
    let pendingBytes = 0;
    while (pendingBytes < this.chunkBytes) {
      const { value, done } = await reader.read();
      if (done) {
        this.finished = true;
        break;
      }
      pending.push(value);
      pendingBytes += value.length;
    }
    return pendingBytes > 0 ? Buffer.concat(pending) : null;
  }

  close(): void {
    if (this.reader === undefined) return;
    if (!this.finished) this.reader.cancel().catch(() => {});
    try {
      this.reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function cancelBody(body: ReadableStream<Uint8Array> | Uint8Array): void {
  if (body instanceof Uint8Array || body.locked) return;
  body.cancel().catch(() => {});
}

export function createClamdScanner(options: ClamdScannerOptions): VirusScanPort {
  const port = options.port ?? 3310;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5000;
  const minBytesPerSecond = options.minBytesPerSecond ?? 0;
  const maxScanBytes = options.maxScanBytes ?? null;
  const chunkBytes = options.chunkBytes ?? 1024 * 1024;
  const log = options.log ?? (() => {});
  const dial = options.connect ?? connect;
  const engine = `clamd@${options.host}:${port}`;

  const exchange = (deadlineMs: number, what: string) =>
    new Exchange(dial, options.host, port, connectTimeoutMs, deadlineMs, what);

  /** PING / VERSION: one short command, socket destroyed on every path. */
  async function command(cmd: string): Promise<Outcome> {
    const ex = exchange(Math.min(timeoutMs, PROBE_TIMEOUT_MS), cmd);
    try {
      if (await ex.connected) await ex.write(Buffer.from(`z${cmd}\0`));
      return await ex.done;
    } finally {
      ex.destroy();
    }
  }

  function tooLarge(size: number, limit: number): Omit<ScanResult, "engine"> {
    return failure(
      "too_large",
      `${size} bytes is more than the scanner scans in full (AV_MAX_SCAN_BYTES=${limit})`,
    );
  }

  async function stream(input: Parameters<VirusScanPort["scan"]>[0]) {
    const source = new ChunkSource(input.body, chunkBytes);
    let ex: Exchange | undefined;
    const signal = input.signal;
    const onAbort = () => ex?.abort("scan aborted (the job is stopping or expired)");
    try {
      if (signal?.aborted === true) {
        return failure("unavailable", "clamd: scan aborted before it started");
      }
      try {
        ex = exchange(scanDeadlineMs(timeoutMs, minBytesPerSecond, input.size), "INSTREAM");
      } catch (error) {
        // The dial itself threw (bad host option, resource exhaustion): the daemon was never
        // reached, so it is `unavailable` and the job retries.
        return failure("unavailable", `clamd: ${String(error)}`);
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      const stop = ex.done.then(() => null);
      if (!(await ex.connected)) return outcomeResult(await ex.done);
      if (!(await ex.write(Buffer.from("zINSTREAM\0")))) return outcomeResult(await ex.done);
      let sent = 0;
      for (;;) {
        const next = source.next();
        next.catch(() => {}); // observed below, or abandoned once the exchange settled
        const chunk = await Promise.race([next, stop]);
        if (ex.settled) break;
        if (chunk === null) {
          await ex.write(Buffer.alloc(4));
          break;
        }
        sent += chunk.length;
        if (maxScanBytes !== null && sent > maxScanBytes) {
          // The declared size was missing or wrong: stop before clamd cuts the stream short.
          return tooLarge(sent, maxScanBytes);
        }
        const header = Buffer.alloc(4);
        header.writeUInt32BE(chunk.length, 0);
        if (!(await ex.write(header)) || !(await ex.write(chunk))) break;
        // Writes that complete at once never return to the event loop, so a reply clamd sent
        // mid-stream (its size limit, then it closes) would sit unread until a later write fails
        // with EPIPE and the socket is torn down with the reply still in its buffer. Let the loop
        // poll the socket between chunks.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return outcomeResult(await ex.done);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      ex?.destroy();
      source.close();
    }
  }

  return {
    driver: "clamd",
    maxScanBytes,
    async scan(input): Promise<ScanResult> {
      const started = Date.now();
      let parsed: Omit<ScanResult, "engine">;
      if (maxScanBytes !== null && input.size !== undefined && input.size > maxScanBytes) {
        cancelBody(input.body);
        parsed = tooLarge(input.size, maxScanBytes);
      } else {
        try {
          parsed = await stream(input);
        } catch (error) {
          // Reading the body failed (storage stream error): the scanner was fine; retry.
          parsed = failure("unavailable", `reading the file failed: ${String(error)}`);
        }
      }
      const fields = {
        verdict: parsed.verdict,
        reason: parsed.reason ?? null,
        durationMs: Date.now() - started,
        size: input.size ?? null,
        source: input.source ?? null,
      };
      if (parsed.verdict === "error") {
        log("avscan.failed", { level: "warn", ...fields, error: parsed.detail ?? null });
      } else {
        log("avscan.scanned", fields);
      }
      return { ...parsed, engine };
    },
    async healthCheck() {
      const outcome = await command("PING");
      if (!outcome.ok) throw new Error(outcome.error);
      if (!outcome.reply.startsWith("PONG")) {
        throw new Error(`clamd: unexpected PING reply ${JSON.stringify(outcome.reply)}`);
      }
    },
    async info() {
      try {
        const outcome = await command("VERSION");
        return outcome.ok ? parseClamdVersion(outcome.reply, engine) : null;
      } catch {
        return null;
      }
    },
  };
}

function outcomeResult(outcome: Outcome): Omit<ScanResult, "engine"> {
  return outcome.ok ? parseClamdReply(outcome.reply) : failure(outcome.reason, outcome.error);
}
