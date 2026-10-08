import type { ESignServices } from "@fundroom/module-kit";

/**
 * PLACEHOLDER (E3.5 foundation): the service the container wires until C1 lands the real one.
 * `connection()` answers "not configured"; everything that would need a vendor throws.
 */
export function createUnconfiguredESignServices(): ESignServices {
  const refuse = (): never => {
    throw new Error("e-sign service not implemented yet");
  };
  return {
    connection: async () => undefined,
    request: async () => refuse(),
    get: async () => undefined,
    signingUrl: async () => refuse(),
    void: async () => refuse(),
    readArtifact: async () => undefined,
  };
}
