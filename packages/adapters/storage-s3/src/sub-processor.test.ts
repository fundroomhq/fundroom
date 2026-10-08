import { describe, expect, it } from "vitest";
import { isOperatorRunEndpoint, s3SubProcessor } from "./sub-processor.js";

describe("s3SubProcessor (E3.11)", () => {
  it("is AWS S3 in the configured region when there is no endpoint", () => {
    expect(s3SubProcessor({ region: "eu-central-1" })).toMatchObject({
      name: "Amazon Web Services, Inc. (Amazon S3)",
      location: "AWS eu-central-1 (Frankfurt, Germany)",
      jurisdiction: "eu",
    });
    expect(s3SubProcessor({ region: "eu-west-2" })?.jurisdiction).toBe("uk");
    expect(s3SubProcessor({ region: "us-east-1" })?.jurisdiction).toBe("us");
    expect(s3SubProcessor({ region: "ap-south-1" })?.jurisdiction).toBe("other");
    expect(s3SubProcessor({})?.jurisdiction).toBe("varies");
  });

  it("is null for an endpoint the operator runs next to the app", () => {
    for (const endpoint of [
      "http://garage:3900",
      "http://minio:9000",
      "http://localhost:9000",
      "http://127.0.0.1:9000",
      "http://10.0.3.4:9000",
      "http://192.168.1.20",
      "http://[fd00::1]:9000",
      "https://seaweed.storage.svc.cluster.local",
      "https://s3.internal",
    ]) {
      expect(s3SubProcessor({ region: "garage", endpoint }), endpoint).toBeNull();
    }
    expect(isOperatorRunEndpoint("s3.example.com")).toBe(false);
  });

  it("recognises a few providers by hostname and never reveals the endpoint", () => {
    const r2eu = s3SubProcessor({ endpoint: "https://acct123.eu.r2.cloudflarestorage.com" });
    expect(r2eu).toMatchObject({ name: "Cloudflare, Inc. (R2)", jurisdiction: "eu" });
    expect(
      s3SubProcessor({ endpoint: "https://acct123.r2.cloudflarestorage.com" })?.jurisdiction,
    ).toBe("varies");
    expect(
      s3SubProcessor({ endpoint: "https://s3.eu-central-003.backblazeb2.com" })?.jurisdiction,
    ).toBe("eu");
    expect(s3SubProcessor({ endpoint: "https://fra1.digitaloceanspaces.com" })).toMatchObject({
      location: "Frankfurt, Germany",
      jurisdiction: "eu",
    });
    expect(
      s3SubProcessor({ endpoint: "https://s3.amazonaws.com", region: "ca-central-1" })
        ?.jurisdiction,
    ).toBe("ca");
    const unknown = s3SubProcessor({ endpoint: "https://objects.example.com" });
    expect(unknown).toMatchObject({ jurisdiction: "varies" });
    for (const meta of [r2eu, unknown]) {
      expect(JSON.stringify(meta)).not.toContain("acct123");
      expect(JSON.stringify(meta)).not.toContain("objects.example.com");
    }
  });
});
