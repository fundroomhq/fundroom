/*
 * `@fundroom/accreditation/testing` (E3.7): the in-memory vendor adapter
 * (`createMemoryAccreditationAdapter`) and the adapter contract suite
 * (`describeAccreditationPortContract`, owned by the adapters agent).
 */

export {
  type AccreditationContractOptions,
  type AccreditationContractSetup,
  type AccreditationContractSetupOptions,
  type AccreditationFakeVendorControl,
  contractStartInput,
  describeAccreditationPortContract,
} from "./contract.js";
export {
  createMemoryAccreditationAdapter,
  MEMORY_SIGNATURE_HEADER,
  type MemoryAccreditationVendor,
  memoryCertificatePdf,
  memorySignature,
} from "./memory-adapter.js";
