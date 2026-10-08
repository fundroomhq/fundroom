/*
 * `@fundroom/accred-verifyinvestor/testing` (E3.7): a scripted fake of the VerifyInvestor.com
 * API (pure `handle(request)` + `fakeFetch`) and the same fake as a real HTTP server.
 */
export { startFakeVerifyInvestor } from "./fake-server.js";
export {
  createFakeVerifyInvestor,
  type FakeRequestLogEntry,
  type FakeVerifyInvestorControl,
  type FakeVerifyInvestorOptions,
  fakeFetch,
  fakePdf,
} from "./fake-vendor.js";
