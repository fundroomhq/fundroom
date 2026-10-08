import { api, call } from "./api.js";

/*
 * Click-wrap certificates and the acceptance register export (E2.3, ADR-0041 D2).
 *
 * Both are authenticated API reads that return bytes rather than JSON, and neither may be a
 * plain `<a download href="…">`. Two reasons, and the second is the one that matters:
 *
 *  - The API is not always same-origin. `apiBase` is a configured origin (an embed, a custom
 *    domain, a dev proxy), and a link navigation to a cross-origin URL carries no `X-Request-Id`
 *    and, in a partitioned-cookie context, may carry no session either — so the download would
 *    succeed for the developer and 401 for the customer.
 *  - A refusal must be *seen*. A link navigation that comes back `403` or `404` replaces the
 *    page (or silently does nothing) with the server's JSON error envelope; fetching the bytes
 *    lets the screen keep its shape and say what happened. Evidence downloads are exactly the
 *    place where "nothing happened" is the wrong answer.
 *
 * So: fetch through the SDK with `parseAs: "blob"`, then hand the blob to the browser through a
 * transient object URL. The URL is revoked on the next tick — revoking it synchronously after
 * `click()` races the browser's own read of it in WebKit.
 */

/** Hands `blob` to the browser as a download named `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** `nda:v2` → `nda-v2`, so the saved file is named after the thing it certifies. */
export function certificateFilename(stamp: string, format: "json" | "pdf"): string {
  const safe = stamp.replace(/[^a-z0-9]+/giu, "-").replace(/^-+|-+$/gu, "");
  return `certificate-${safe === "" ? "acceptance" : safe}.${format}`;
}

/**
 * Downloads one acceptance's certificate. The signer may fetch their own; anybody else needs
 * `compliance.read`, and a caller who is neither gets the 404 an unknown certificate gives —
 * so a failure here is deliberately not distinguishable from "there is no such certificate".
 */
export async function downloadCertificate(
  membershipId: string,
  stamp: string,
  format: "json" | "pdf" = "pdf",
): Promise<void> {
  const blob = await call(
    api().GET("/compliance/acceptances/{membershipId}/certificate", {
      params: { path: { membershipId }, query: { stamp, format } },
      parseAs: "blob",
    }),
  );
  saveBlob(blob, certificateFilename(stamp, format));
}

/**
 * The whole acceptance register in one file, for counsel (design/04 §1.6, §7). The server
 * bounds it and applies the same filters the on-screen register uses: an evidence export that
 * stopped at the first page would be worse than none, because nobody reading it would know.
 */
export async function downloadRegister(
  filter: { documentId?: string | undefined; slug?: string | undefined },
  format: "csv" | "json" = "csv",
): Promise<void> {
  const blob = await call(
    api().GET("/compliance/acceptances/export", {
      params: {
        query: {
          format,
          ...(filter.documentId === undefined ? {} : { documentId: filter.documentId }),
          ...(filter.slug === undefined ? {} : { slug: filter.slug }),
        },
      },
      parseAs: "blob",
    }),
  );
  saveBlob(blob, `acceptance-register.${format}`);
}
