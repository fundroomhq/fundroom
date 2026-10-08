/*
 * `@fundroom/accred-parallel-markets/testing` (E3.7): a scripted fake of the Parallel Markets
 * Server API v2 (pure `handle(request)` + `fakeFetch`) and the same fake as a real HTTP server.
 */
export { startFakeParallelMarkets } from "./fake-server.js";
export {
  createFakeParallelMarkets,
  type FakeParallelMarketsControl,
  type FakeParallelMarketsOptions,
  type FakeRequestLogEntry,
  fakeFetch,
  fakePdf,
} from "./fake-vendor.js";
