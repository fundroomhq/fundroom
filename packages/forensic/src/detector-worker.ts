import { parentPort } from "node:worker_threads";
import {
  type DetectCandidate,
  type DetectOptions,
  detectForensicMarks,
  type GrayImage,
} from "./engine.js";

/*
 * Worker-thread side of `createForensicDetector` (detector.ts): runs one detection per message
 * so the CPU-heavy registration and correlation never block the server's event loop.
 */
export interface DetectJob {
  readonly id: number;
  readonly reference: GrayImage;
  readonly suspect: GrayImage;
  readonly candidates: readonly DetectCandidate[];
  readonly options?: DetectOptions | undefined;
}

parentPort?.on("message", (job: DetectJob) => {
  try {
    const result = detectForensicMarks(job.reference, job.suspect, job.candidates, job.options);
    parentPort?.postMessage({ id: job.id, result });
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    parentPort?.postMessage({ id: job.id, error: { name: e.name, message: e.message } });
  }
});
