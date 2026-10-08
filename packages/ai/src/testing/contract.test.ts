import { ModelProviderError, type ModelResult } from "@fundroom/ports";
import {
  describeModelPortContract,
  type ModelContractObserved,
  type ModelContractReply,
  nextContractReply,
} from "./contract.js";
import { createFakeModel } from "./fake-model.js";

/*
 * The contract suite against the fake model (E3.12 §8): the fake does not retry, so a retryable
 * failure must surface as `retryable: true` for the kernel to see.
 */
describeModelPortContract(
  "fake model",
  () => {
    const queue: ModelContractReply[] = [];
    const received: ModelContractObserved[] = [];
    const port = createFakeModel({
      respond: (req) => {
        received.push({
          system: req.system,
          messages: req.messages,
          maxOutputTokens: req.maxOutputTokens,
          schema: req.json?.schema ?? null,
        });
        const reply = nextContractReply(queue);
        switch (reply.kind) {
          case "ok":
            return {
              text: reply.text,
              finish: reply.finish,
              usage: { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens },
              model: reply.model,
            };
          case "error": {
            const retryable = reply.code === "rate_limited" || reply.code === "unavailable";
            return new ModelProviderError(reply.code, `fake ${reply.code}`, retryable);
          }
          case "hang":
            return new Promise<ModelResult>((_, reject) => {
              req.signal?.addEventListener("abort", () => reject(req.signal?.reason), {
                once: true,
              });
            });
        }
      },
    });
    return { port, backend: { reply: (...r) => queue.push(...r), received } };
  },
  { retriesOnce: false },
);

/* A third-party fake whose training terms are not stated passes the static half. */
describeModelPortContract("fake model (third party, terms not stated)", () =>
  createFakeModel({
    info: {
      hosting: "third_party",
      trainsOnInputs: null,
      subProcessor: {
        name: "Example AI",
        purpose: "AI assist",
        dataProcessed: "Prompts",
        location: "Not stated by the host",
        jurisdiction: "varies",
      },
    },
  }),
);
