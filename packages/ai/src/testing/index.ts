/*
 * `@fundroom/ai/testing` (E3.12): the fake model every test uses (`createFakeModel`) and the
 * ModelPort contract suite (`describeModelPortContract`, owned by the adapters agent).
 */

export {
  describeModelPortContract,
  type ModelContractBackend,
  type ModelContractHarness,
  type ModelContractObserved,
  type ModelContractOptions,
  type ModelContractReply,
  type ModelContractSetup,
  nextContractReply,
} from "./contract.js";
export { createFakeModel, type FakeModel, type FakeModelOptions } from "./fake-model.js";
