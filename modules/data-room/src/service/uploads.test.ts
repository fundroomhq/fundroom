import type { TenantContext } from "@fundroom/db";
import type { DataRoomSettings } from "@fundroom/domain";
import type { ModuleServices } from "@fundroom/module-kit";
import { MULTIPART_MAX_PARTS, MULTIPART_PART_BYTES } from "@fundroom/storage";
import { describe, expect, it, vi } from "vitest";
import { DataRoomError } from "../errors.js";
import { scanErrorDetail } from "./ingest.js";
import { createUploadService } from "./uploads.js";

const GiB = 1024 ** 3;
const MULTIPART_MAX = MULTIPART_PART_BYTES * MULTIPART_MAX_PARTS;
const ctx = { workspaceId: "00000000-0000-4000-8000-000000000001" } as unknown as TenantContext;
const actor = { membershipId: "00000000-0000-4000-8000-000000000002", requestId: "r" };
const settings = { maxUploadBytes: null } as unknown as DataRoomSettings;

function stubServices(uploadMaxBytes: number, presignedMultipart: boolean) {
  const withTenant = vi.fn();
  const create = vi.fn();
  const services = {
    db: { withTenant },
    storage: { capabilities: { presignedMultipart }, multipart: { create } },
    limits: { uploadMaxBytes },
    now: () => new Date("2026-10-22T00:00:00Z"),
  } as unknown as ModuleServices;
  return { services, withTenant, create };
}

async function refusal(promise: Promise<unknown>): Promise<DataRoomError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DataRoomError);
  return error as DataRoomError;
}

describe("uploads.start: the multipart part limit", () => {
  it("refuses a multipart upload over part size × part limit before any row or upload exists", async () => {
    const s = stubServices(5 * 1024 * GiB, true);
    const error = await refusal(
      createUploadService(s.services).start(
        ctx,
        {
          fileName: "big.pdf",
          size: MULTIPART_MAX + 1,
          contentType: "application/pdf",
          folderId: "f",
        },
        actor,
        settings,
      ),
    );
    expect(error.code).toBe("payload_too_large");
    expect(error.details).toEqual({ maxBytes: MULTIPART_MAX });
    expect(s.withTenant).not.toHaveBeenCalled();
    expect(s.create).not.toHaveBeenCalled();
  });

  it("names the lower ceiling when the configured one is below the multipart limit", async () => {
    const s = stubServices(5 * GiB, true);
    const error = await refusal(
      createUploadService(s.services).start(
        ctx,
        { fileName: "big.pdf", size: 6 * GiB, contentType: "application/pdf", folderId: "f" },
        actor,
        settings,
      ),
    );
    expect(error.code).toBe("payload_too_large");
    expect(error.details).toEqual({ maxBytes: 5 * GiB });
    expect(s.withTenant).not.toHaveBeenCalled();
  });

  it("does not apply the multipart limit to tus uploads", async () => {
    const s = stubServices(5 * 1024 * GiB, false);
    s.withTenant.mockRejectedValue(new Error("reached the database"));
    await expect(
      createUploadService(s.services).start(
        ctx,
        {
          fileName: "big.pdf",
          size: MULTIPART_MAX + 1,
          contentType: "application/pdf",
          folderId: "f",
        },
        actor,
        settings,
      ),
    ).rejects.toThrow("reached the database");
  });
});

describe("scanErrorDetail", () => {
  it("prefixes the reason when the scanner gives one", () => {
    expect(
      scanErrorDetail({
        verdict: "error",
        engine: "clamd",
        reason: "too_large",
        detail: "INSTREAM size limit exceeded",
        retryable: false,
      }),
    ).toBe("too_large: INSTREAM size limit exceeded");
    expect(scanErrorDetail({ verdict: "error", engine: "clamd", reason: "timeout" })).toBe(
      "timeout",
    );
    expect(scanErrorDetail({ verdict: "error", engine: "clamd", detail: "boom" })).toBe("boom");
    expect(scanErrorDetail({ verdict: "error", engine: "clamd" })).toBeNull();
  });
});
