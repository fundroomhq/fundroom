import type { ModelPort, ModelProviderInfo, ModelRequest, ModelResult } from "@fundroom/ports";

export interface FakeModelOptions {
  readonly info?: Partial<ModelProviderInfo>;
  /**
   * Answers one request. Return (or resolve) a result, or return an `Error` to have `generate`
   * reject with it (e.g. a `ModelProviderError`). Default: `{}` as JSON, `stop`, 1+1 tokens.
   */
  readonly respond?: (req: ModelRequest) => ModelResult | Promise<ModelResult> | Error;
}

export interface FakeModel extends ModelPort {
  /** Every request, in order. */
  readonly calls: ModelRequest[];
}

const DEFAULT_RESULT: ModelResult = {
  text: "{}",
  finish: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
  model: "fake",
};

/** An in-memory `ModelPort`: self-hosted, operator-run (no sub-processor), records its calls. */
export function createFakeModel(opts: FakeModelOptions = {}): FakeModel {
  const info: ModelProviderInfo = {
    id: "fake",
    label: "Fake model",
    model: "fake",
    hosting: "self_hosted",
    location: null,
    jurisdiction: null,
    trainsOnInputs: false, // override with null to model a third-party host of unknown terms
    retention: "Nothing is stored: the fake model runs in the test process.",
    subProcessor: null,
    ...opts.info,
  };
  const calls: ModelRequest[] = [];
  return {
    info,
    calls,
    async generate(req) {
      calls.push(req);
      if (req.signal?.aborted === true) throw req.signal.reason ?? new Error("aborted");
      const answer = opts.respond === undefined ? DEFAULT_RESULT : opts.respond(req);
      if (answer instanceof Error) throw answer;
      return await answer;
    },
  };
}
