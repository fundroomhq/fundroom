import type { FundRoomSchemas } from "@fundroom/sdk";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";

/*
 * Forensic (invisible) watermarking, E3.13 (ADR-0061). Staff with `data-room.forensics` can test
 * a leaked page image against every recipient who was served a marked copy of a document
 * version, and list who was served one. Both routes live under the data-room module.
 */
export type ForensicDetectionResult = FundRoomSchemas["ForensicDetectionResult"];
export type ForensicMatch = ForensicDetectionResult["results"][number];
export type ForensicVerdict = FundRoomSchemas["ForensicVerdict"];
export type ForensicRecipient = FundRoomSchemas["ForensicRecipient"];
export type ForensicRecipientPage = FundRoomSchemas["ForensicRecipientPage"];

/** Mirrors `FORENSIC_DETECT_MAX_BYTES` / `FORENSIC_DETECT_CONTENT_TYPES` (data-room contracts). */
export const FORENSIC_MAX_BYTES = 15 * 1024 * 1024;
export const FORENSIC_CONTENT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export function forensicRecipientsQuery(documentId: string, versionId: string | undefined) {
  return infiniteQueryOptions({
    queryKey: ["data-room", "forensic-recipients", documentId, versionId ?? "all"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call(
        api().GET("/data-room/documents/{id}/forensic/recipients", {
          params: {
            path: { id: documentId },
            query: {
              limit: 100,
              ...(versionId === undefined ? {} : { versionId }),
              ...(pageParam === undefined ? {} : { cursor: pageParam }),
            },
          },
        }),
      ),
    getNextPageParam: (last: ForensicRecipientPage) => last.nextCursor ?? undefined,
  });
}

export interface ForensicDetectInput {
  image: File;
  page: number;
  versionId?: string | undefined;
}

/**
 * `multipart/form-data`: the SDK types `image` as a binary string, so the body is built as
 * `FormData` and handed through unchanged (openapi-fetch leaves the boundary to the browser).
 * The image goes to this server for one test only; it is never stored.
 */
export function detectForensicMark(
  documentId: string,
  input: ForensicDetectInput,
): Promise<ForensicDetectionResult> {
  const form = new FormData();
  form.append("image", input.image, input.image.name);
  form.append("page", String(input.page));
  if (input.versionId) form.append("versionId", input.versionId);
  return call(
    api().POST("/data-room/documents/{id}/forensic/detect", {
      params: { path: { id: documentId } },
      body: form as unknown as FundRoomSchemas["ForensicDetectRequest"],
      bodySerializer: (body) => body as unknown as FormData,
    }),
  );
}
