import type { SpreadsheetPort } from "@fundroom/ports";

/**
 * `SPREADSHEET_DRIVER=noop`: the spreadsheet integration, switched off (E2.4 §8).
 *
 * An operator who does not want this process talking to Google at all — an air-gapped install,
 * a compliance rule about third-party processors, or simply "we type our numbers in" — sets the
 * driver to `noop` and every read answers `not_found`. That answer is chosen deliberately over
 * a throw or an `unauthorized`: the sync records a typed failure and moves on, the admin screen
 * shows the same "we could not read the sheet" row it shows for a deleted spreadsheet, and
 * nothing anywhere has to special-case a driver being absent.
 */
export function createNoopSpreadsheets(): SpreadsheetPort {
  return {
    driver: "noop",
    async read() {
      return {
        ok: false,
        reason: "not_found",
        detail:
          "the spreadsheet integration is disabled on this instance (SPREADSHEET_DRIVER=noop)",
      };
    },
    async healthCheck() {},
  };
}
