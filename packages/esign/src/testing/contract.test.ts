import { describeESignPortContract } from "./contract.js";
import { createMemoryESignAdapter } from "./memory-adapter.js";

// The in-memory adapter every other package's tests rely on must itself honour the port contract.
describeESignPortContract("memory adapter", async (options) => {
  const { definition, vendor } = createMemoryESignAdapter("documenso");
  const port = definition.create(
    {
      credentials: { apiToken: options?.credentials === "invalid" ? "invalid" : "token-1" },
      callbackSecret: "contract-secret",
    },
    {
      fetch: () => Promise.reject(new Error("memory adapter makes no HTTP calls")),
      now: () => new Date(),
    },
  );
  return { port, vendor, cleanup: async () => {} };
});
