import { connect, type Socket } from "node:net";
import type { ScanResult, VirusScanPort } from "@fundroom/ports";

/*
 * ClamAV over the clamd TCP protocol (design/02 §4 "ClamAV … clamd socket … async job").
 * INSTREAM: `zINSTREAM\0`, then `<uint32 BE length><bytes>` chunks, then a zero-length
 * chunk; the daemon answers `stream: OK\0`, `stream: <signature> FOUND\0` or
 * `<message> ERROR\0`. Chunks are capped (clamd's `StreamMaxLength`, default 25 MiB per
 * stream; the operator raises it for large documents) and a size-limit error is reported as
 * an `error` verdict rather than a crash so the job can park the blob for review.
 */
export interface ClamdScannerOptions {
  readonly host: string;
  /** Default 3310. */
  readonly port?: number | undefined;
  /** Whole-scan deadline. Default 120 s. */
  readonly timeoutMs?: number | undefined;
  /** Chunk size sent to the daemon. Default 1 MiB. */
  readonly chunkBytes?: number | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
  /** Test seam. */
  readonly connect?: typeof connect | undefined;
}

export function parseClamdReply(reply: string): Omit<ScanResult, "engine"> {
  const text = reply.replace(/\0+$/u, "").trim();
  if (/\bOK$/u.test(text)) return { verdict: "clean" };
  const found = /^(?:stream: )?(.+?) FOUND$/u.exec(text);
  if (found?.[1]) return { verdict: "infected", detail: found[1] };
  return { verdict: "error", detail: text || "empty reply" };
}

function command(socket: Socket, cmd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`clamd: ${cmd} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      out += chunk;
      if (out.includes("\0")) {
        clearTimeout(timer);
        socket.end();
        resolve(out);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    socket.write(`z${cmd}\0`);
  });
}

export function createClamdScanner(options: ClamdScannerOptions): VirusScanPort {
  const port = options.port ?? 3310;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const chunkBytes = options.chunkBytes ?? 1024 * 1024;
  const log = options.log ?? (() => {});
  const dial = options.connect ?? connect;
  const engine = `clamd@${options.host}:${port}`;

  function open(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = dial({ host: options.host, port });
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
  }

  async function* chunksOf(
    body: ReadableStream<Uint8Array> | Uint8Array,
  ): AsyncGenerator<Uint8Array> {
    if (body instanceof Uint8Array) {
      for (let i = 0; i < body.length; i += chunkBytes) yield body.subarray(i, i + chunkBytes);
      return;
    }
    const reader = body.getReader();
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending.push(value);
      pendingBytes += value.length;
      if (pendingBytes >= chunkBytes) {
        yield Buffer.concat(pending);
        pending = [];
        pendingBytes = 0;
      }
    }
    if (pendingBytes > 0) yield Buffer.concat(pending);
  }

  function write(socket: Socket, data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.write(data, (error) => (error ? reject(error) : resolve()));
    });
  }

  return {
    driver: "clamd",
    async scan(input): Promise<ScanResult> {
      const started = Date.now();
      let socket: Socket | undefined;
      try {
        socket = await open();
        const reply = new Promise<string>((resolve, reject) => {
          let out = "";
          const timer = setTimeout(() => {
            socket?.destroy();
            reject(new Error(`clamd: INSTREAM timed out after ${timeoutMs} ms`));
          }, timeoutMs);
          socket?.on("data", (chunk: Buffer) => {
            out += chunk.toString("utf8");
            if (out.includes("\0")) {
              clearTimeout(timer);
              resolve(out);
            }
          });
          socket?.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          socket?.on("close", () => {
            clearTimeout(timer);
            resolve(out);
          });
        });
        await write(socket, Buffer.from("zINSTREAM\0"));
        const header = Buffer.alloc(4);
        for await (const chunk of chunksOf(input.body)) {
          header.writeUInt32BE(chunk.length, 0);
          await write(socket, header);
          await write(socket, chunk);
          if (socket.destroyed) break;
        }
        if (!socket.destroyed) await write(socket, Buffer.alloc(4));
        const parsed = parseClamdReply(await reply);
        log("avscan.scanned", {
          verdict: parsed.verdict,
          durationMs: Date.now() - started,
          size: input.size ?? null,
        });
        return { ...parsed, engine };
      } catch (error) {
        log("avscan.failed", { level: "warn", error: String(error) });
        return { verdict: "error", engine, detail: String(error) };
      } finally {
        socket?.destroy();
      }
    },
    async healthCheck() {
      const socket = await open();
      const reply = await command(socket, "PING", Math.min(timeoutMs, 5000));
      if (!reply.startsWith("PONG")) throw new Error(`clamd: unexpected PING reply ${reply}`);
    },
  };
}
