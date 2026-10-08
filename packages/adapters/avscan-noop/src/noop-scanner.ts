import type { ScanResult, VirusScanPort } from "@fundroom/ports";

/*
 * The zero-infrastructure scanner (EXECUTION_PLAN §5.2 `avscan-noop`): every blob comes
 * back `skipped`, which the data room records on the row and shows as an "unscanned"
 * warning to admins. Whether a skipped blob is servable is a workspace setting
 * (`dataRoom.allowUnscanned`), so the operator makes that trade-off explicitly.
 */
export interface NoopScannerOptions {
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

export function createNoopScanner(options: NoopScannerOptions = {}): VirusScanPort {
  let warned = false;
  return {
    driver: "noop",
    async scan(input): Promise<ScanResult> {
      if (!warned) {
        warned = true;
        options.log?.("avscan.noop", {
          level: "warn",
          reason: "AV_DRIVER=noop: uploads are not scanned; set AV_DRIVER=clamd for production",
        });
      }
      // Drain a stream so the caller's storage read completes cleanly.
      if (!(input.body instanceof Uint8Array)) {
        const reader = input.body.getReader();
        while (!(await reader.read()).done) {
          /* drain */
        }
      }
      return { verdict: "skipped", engine: "noop" };
    },
    async healthCheck() {
      /* nothing to probe */
    },
  };
}
