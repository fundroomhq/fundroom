import { sleep } from "k6";
import encoding from "k6/encoding";
import { SEED_CONTENT } from "./config.js";
import { get, ok, post, send } from "./http.js";

/*
 * `seed-demo` creates people only: no documents, no updates. A browse profile with an empty data
 * room measures nothing, so setup() tops it up as the owner: one small text PDF uploaded over tus
 * exactly as the admin UI does it, granted to the investor role, and one update published to the
 * web archive (not emailed — a load run should not fan out mail). Idempotent: an existing
 * viewable document / archived update is reused. SEED_CONTENT=false skips it.
 *
 * Two of these calls are step-up routes (data-room settings, grants); `openSessions` has already
 * stepped the owner up with TOTP (session.js `stepUpOwner`), which also makes them fresh.
 */
function textPdf(pages) {
  const objects = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((text, i) => {
    const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out; // ASCII only, so string length == byte length
}

function viewableDocument(owner) {
  const tree = ok(get(owner, "/data-room/tree"), "data-room tree");
  for (const d of tree.documents || []) {
    const detail = get(owner, `/data-room/documents/${d.id}`, "/data-room/documents/{id}");
    if (detail.status !== 200) continue;
    const doc = detail.json();
    if (doc.availability?.viewable && (doc.currentVersion?.pageCount || 0) > 0) {
      return {
        id: d.id,
        versionId: doc.currentVersion.id,
        pageCount: doc.currentVersion.pageCount,
      };
    }
  }
  return { rootId: tree.rootId };
}

function uploadPdf(owner, rootId) {
  // No scanner in the compose stack: let the room serve unscanned files (step-up route).
  send(owner, "PATCH", "/data-room/settings", { allowUnscanned: true }, "/data-room/settings");
  const pdf = textPdf(["FundRoom load profile, page one", "Runway and milestones, page two"]);
  const fileName = "load-profile.pdf";
  const start = ok(
    post(owner, "/data-room/uploads", {
      fileName,
      size: pdf.length,
      contentType: "application/pdf",
      folderId: rootId,
    }),
    "upload start",
  );
  if (!start.tus) throw new Error(`expected a tus upload (filesystem driver), got ${start.method}`);
  const b64 = (s) => encoding.b64encode(s);
  const created = post(owner, start.tus.path, undefined, "tus create", {
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(pdf.length),
      "Upload-Metadata": `upload ${b64(start.upload.id)},filename ${b64(fileName)},filetype ${b64("application/pdf")}`,
    },
  });
  if (created.status !== 201) throw new Error(`tus create: HTTP ${created.status} ${created.body}`);
  const patched = send(owner, "PATCH", `${start.tus.path}/${start.upload.id}`, pdf, "tus patch", {
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": "0",
      "Content-Type": "application/offset+octet-stream",
    },
  });
  if (patched.status !== 204) throw new Error(`tus patch: HTTP ${patched.status} ${patched.body}`);
  const done = ok(post(owner, `/data-room/uploads/${start.upload.id}/complete`, {}), "complete");
  const id = done.document.id;
  const detail = ok(get(owner, `/data-room/documents/${id}`), "document");
  const grant = post(owner, "/access/grants", {
    subject: { kind: "role", role: "investor" },
    resource: { kind: "document", id, path: detail.folder.path },
    capabilities: ["view"],
  });
  if (grant.status >= 300) console.warn(`investor grant refused (${grant.status}): ${grant.body}`);
  for (let i = 0; i < 120; i++) {
    const d = ok(get(owner, `/data-room/documents/${id}`), "document");
    if (d.availability?.viewable && (d.currentVersion?.pageCount || 0) > 0) {
      return { id, versionId: d.currentVersion.id, pageCount: d.currentVersion.pageCount };
    }
    sleep(1);
  }
  throw new Error("the uploaded PDF never became viewable (render worker running?)");
}

function archivedUpdate(owner, investor, create) {
  const archive = ok(get(investor, "/updates/archive"), "updates archive");
  if (archive.posts.length > 0) return archive.posts[0].slug;
  if (!create) return undefined;
  const created = ok(
    post(owner, "/updates/posts", { title: "Load profile update", template: "minimal" }),
    "create update",
  );
  const id = created.post.id;
  const published = post(owner, `/updates/posts/${id}/publish`, undefined);
  if (published.status >= 300) {
    console.warn(`publish refused (${published.status}); sending instead: ${published.body}`);
    ok(send(owner, "POST", `/updates/posts/${id}/send`, undefined), "send update");
  }
  for (let i = 0; i < 60; i++) {
    const a = ok(get(investor, "/updates/archive"), "updates archive");
    if (a.posts.length > 0) return a.posts[0].slug;
    sleep(1);
  }
  return undefined;
}

/** `{ document?: {id, versionId, pageCount}, updateSlug? }` — whatever the room has or gained. */
export function ensureContent(owner, investor) {
  const found = viewableDocument(owner);
  let document = found.id ? found : undefined;
  if (document === undefined && SEED_CONTENT) document = uploadPdf(owner, found.rootId);
  const updateSlug = archivedUpdate(owner, investor, SEED_CONTENT);
  return { document, updateSlug };
}
