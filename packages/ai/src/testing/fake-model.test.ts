import { ModelProviderError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { aiProviderKey } from "../index.js";
import { describeModelPortContract } from "./contract.js";
import { createFakeModel } from "./fake-model.js";

describeModelPortContract("fake", () => createFakeModel());

describe("createFakeModel", () => {
  const req = {
    system: "s",
    messages: [{ role: "user", content: "u" }] as const,
    maxOutputTokens: 10,
  };

  it("answers {} by default and records calls", async () => {
    const m = createFakeModel();
    expect(await m.generate(req)).toEqual({
      text: "{}",
      finish: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
      model: "fake",
    });
    expect(m.calls).toEqual([req]);
    expect(m.info).toMatchObject({ id: "fake", hosting: "self_hosted", subProcessor: null });
  });

  it("uses respond, rejects with a returned Error, and overrides info", async () => {
    const m = createFakeModel({
      info: { label: "Other" },
      respond: (r) =>
        r.system === "fail"
          ? new ModelProviderError("unavailable", "down", true)
          : { text: "x", finish: "length", usage: { inputTokens: 2, outputTokens: 3 }, model: "m" },
    });
    expect(m.info.label).toBe("Other");
    expect((await m.generate(req)).finish).toBe("length");
    await expect(m.generate({ ...req, system: "fail" })).rejects.toBeInstanceOf(ModelProviderError);
  });

  it("aiProviderKey joins id, hosting, label and model", () => {
    expect(aiProviderKey(createFakeModel().info)).toBe(
      '["fake","self_hosted","Fake model","fake",null,null]',
    );
  });
});
