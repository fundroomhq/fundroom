import { Worker } from "node:worker_threads";
import type { DetectCandidate, DetectOptions, DetectResult, GrayImage } from "./engine.js";

/*
 * A small worker-thread pool for `detectForensicMarks` (review R1-1): a detection takes ~0.5–1 s
 * of pure CPU on a normal page (more for 2,000 candidates) and must not stall every other request
 * in the process. `concurrency` workers run jobs; up to `maxQueue` more wait; beyond that the
 * call rejects at once with `ForensicBusyError` (the route answers 503 `forensic_busy`).
 * Workers start lazily, are reused, and are replaced after a crash.
 */

/** The detector's queue is full; retry later. */
export class ForensicBusyError extends Error {
  override readonly name = "ForensicBusyError";
  constructor() {
    super("forensic: the detector is busy; try again shortly");
  }
}

export interface ForensicDetectorOptions {
  /** Worker threads (parallel detections). Default 1. */
  readonly concurrency?: number | undefined;
  /** Detections allowed to wait for a worker. Default 4. */
  readonly maxQueue?: number | undefined;
  /**
   * Deadline per detection once it reaches a worker (ms). Default 30,000. On expiry the worker is
   * terminated (and respawned for the next job) and the call rejects with ForensicTimeoutError.
   */
  readonly timeoutMs?: number | undefined;
  /** V8 heap limits per worker. Default { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64 }. */
  readonly resourceLimits?: import("node:worker_threads").ResourceLimits | undefined;
}

/** A detection exceeded the detector's deadline; its worker was replaced. */
export class ForensicTimeoutError extends Error {
  override readonly name = "ForensicTimeoutError";
  constructor(ms: number) {
    super(`forensic: detection timed out after ${ms} ms`);
  }
}

export interface ForensicDetector {
  detect(
    reference: GrayImage,
    suspect: GrayImage,
    candidates: readonly DetectCandidate[],
    options?: DetectOptions,
  ): Promise<DetectResult>;
  /** Terminates the workers; pending and queued detections reject. */
  close(): Promise<void>;
}

interface Job {
  readonly id: number;
  readonly message: unknown;
  readonly resolve: (r: DetectResult) => void;
  readonly reject: (e: Error) => void;
}

interface Slot {
  worker: Worker | undefined;
  job: Job | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** dist/detector-worker.js — also when this module runs from src/ under a TS test runner. */
function workerUrl(): URL {
  const here = import.meta.url;
  return /\/src\/detector\.ts$/u.test(here)
    ? new URL("../dist/detector-worker.js", here)
    : new URL("./detector-worker.js", here);
}

function revive(error: { name: string; message: string }): Error {
  const e = error.name === "RangeError" ? new RangeError(error.message) : new Error(error.message);
  return e;
}

export function createForensicDetector(options: ForensicDetectorOptions = {}): ForensicDetector {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const maxQueue = Math.max(0, Math.floor(options.maxQueue ?? 4));
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 30_000));
  const resourceLimits = options.resourceLimits ?? {
    maxOldGenerationSizeMb: 512,
    maxYoungGenerationSizeMb: 64,
  };
  const slots: Slot[] = Array.from({ length: concurrency }, () => ({
    worker: undefined,
    job: undefined,
    timer: undefined,
  }));

  /** Frees the slot (timer, job) and returns the job it held. */
  function release(slot: Slot): Job | undefined {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    const job = slot.job;
    slot.job = undefined;
    return job;
  }

  /** Terminates and forgets the slot's worker (the next job spawns a fresh one). */
  function discard(slot: Slot): void {
    const worker = slot.worker;
    slot.worker = undefined;
    if (worker) void worker.terminate().catch(() => {});
  }
  const queue: Job[] = [];
  let nextId = 1;
  let closed = false;

  function spawn(slot: Slot): Worker {
    const worker = new Worker(workerUrl(), { resourceLimits });
    worker.on(
      "message",
      (msg: { id: number; result?: DetectResult; error?: { name: string; message: string } }) => {
        if (slot.worker !== worker) return; // a discarded (timed-out) worker's late answer
        const job = slot.job;
        if (!job || job.id !== msg.id) return;
        release(slot);
        worker.unref();
        if (msg.error) job.reject(revive(msg.error));
        else job.resolve(msg.result as DetectResult);
        pump();
      },
    );
    const fail = (error: Error) => {
      if (slot.worker !== worker) return; // already replaced; its slot belongs to someone else
      slot.worker = undefined;
      release(slot)?.reject(error);
      if (!closed) pump();
    };
    worker.on("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
    worker.on("exit", (code) => fail(new Error(`forensic: detector worker exited (${code})`)));
    worker.unref(); // an idle detector never keeps the process alive (ref'd while working)
    slot.worker = worker;
    return worker;
  }

  /**
   * Hands queued jobs to free slots. Never leaves a slot holding a job it could not dispatch: a
   * throwing spawn/postMessage (e.g. DataCloneError) rejects that job and frees the slot, and a
   * dispatched job gets a deadline after which its worker is terminated and replaced (review RR-2).
   */
  function pump(): void {
    for (const slot of slots) {
      while (!slot.job && queue.length > 0 && !closed) {
        const job = queue.shift() as Job;
        slot.job = job;
        try {
          const worker = slot.worker ?? spawn(slot);
          worker.ref();
          worker.postMessage(job.message);
        } catch (error) {
          release(slot);
          job.reject(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
        slot.timer = setTimeout(() => {
          if (slot.job !== job) return;
          release(slot);
          discard(slot);
          job.reject(new ForensicTimeoutError(timeoutMs));
          pump();
        }, timeoutMs);
        slot.timer.unref();
      }
    }
  }

  return {
    detect(reference, suspect, candidates, opts) {
      if (closed) return Promise.reject(new Error("forensic: detector is closed"));
      const busy = slots.filter((s) => s.job).length;
      if (busy >= concurrency && queue.length >= maxQueue)
        return Promise.reject(new ForensicBusyError());
      return new Promise<DetectResult>((resolve, reject) => {
        const id = nextId++;
        const message = {
          id,
          reference: { width: reference.width, height: reference.height, data: reference.data },
          suspect: { width: suspect.width, height: suspect.height, data: suspect.data },
          candidates: candidates.map((c) => ({ id: c.id, seed: c.seed })),
          options: opts,
        };
        queue.push({ id, message, resolve, reject });
        pump();
      });
    },

    async close() {
      closed = true;
      const error = new Error("forensic: detector is closed");
      for (const job of queue.splice(0)) job.reject(error);
      await Promise.all(
        slots.map(async (slot) => {
          const worker = slot.worker;
          slot.worker = undefined;
          release(slot)?.reject(error);
          if (worker) await worker.terminate();
        }),
      );
    },
  };
}
