import type { DirectoryCell } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { signupRegionsOf } from "./signup-regions.js";

const cell = (values: Partial<DirectoryCell> & { id: string; region: string }): DirectoryCell => ({
  regionLabel: "",
  jurisdiction: null,
  publicOrigin: "",
  status: "active",
  exportPublicKey: null,
  heartbeatAt: null,
  local: false,
  ...values,
});

describe("signupRegionsOf", () => {
  it("local mode: this region only, labelled from the declaration when the cell has none", () => {
    expect(
      signupRegionsOf([cell({ id: "default", region: "eu", local: true })], {
        code: "eu",
        label: "European Union",
        jurisdiction: "eu",
      }),
    ).toEqual([{ region: "eu", label: "European Union", jurisdiction: "eu", signupUrl: null }]);
    // Nothing declared at all: the code is the label.
    expect(
      signupRegionsOf([cell({ id: "default", region: "default", local: true })], null),
    ).toEqual([{ region: "default", label: "default", jurisdiction: null, signupUrl: null }]);
  });

  it("offers one entry per remote region: active, reachable over https, first cell by id", () => {
    const items = signupRegionsOf(
      [
        cell({ id: "eu-1", region: "eu", local: true, regionLabel: "EU", jurisdiction: "eu" }),
        cell({ id: "eu-7", region: "eu", publicOrigin: "https://eu7.example" }),
        cell({ id: "us-2", region: "us", publicOrigin: "https://us2.example" }),
        cell({ id: "us-1", region: "us", publicOrigin: "https://us1.example", regionLabel: "US" }),
        cell({ id: "ap-1", region: "ap", publicOrigin: "https://ap.example", status: "draining" }),
        cell({ id: "ca-1", region: "ca" }),
        cell({ id: "uk-1", region: "uk", publicOrigin: "http://uk.example" }),
      ],
      null,
    );
    expect(items).toEqual([
      { region: "eu", label: "EU", jurisdiction: "eu", signupUrl: null },
      { region: "us", label: "US", jurisdiction: null, signupUrl: "https://us1.example/signup" },
    ]);
  });

  it("offers no local region when none of this database's cells takes new workspaces", () => {
    expect(
      signupRegionsOf(
        [
          cell({ id: "eu-1", region: "eu", local: true, status: "draining" }),
          cell({ id: "us-1", region: "us", publicOrigin: "https://us1.example" }),
        ],
        null,
      ).map((i) => i.region),
    ).toEqual(["us"]);
  });
});
