# Runbook: document rendering, watermarks and chart images

Everything the install rasterises goes through one component: the `DocumentRenderPort`, backed by PDFium (WASM), pdf-lib and sharp, all in-process and with no system packages — the runtime image is distroless. It produces four things: data-room **page renditions** for the in-app viewer, **thumbnails**, **watermarked downloads**, and the **chart PNGs** embedded in investor-update emails. This runbook is for whoever operates the install: what the `render` readiness check means, what a blank watermark looks like and what to do about it, and how to tell a rendering fault from a document fault.

Reference material: `packages/adapters/render-pdfium` (sanitisation, rasterisation and watermarking) and `packages/storage` (renditions are served through the app, never through a presigned URL).

## What has to be true first

- **You can reach `/readyz` on the node you are diagnosing.** Not through the load balancer — a failing node is exactly the one the balancer has stopped sending you to. Note that **nothing polls `/readyz` for you**: the container `HEALTHCHECK`, Compose and Caddy all poll `/healthz` (liveness), deliberately — see §0.
- **You know which image tag the node is running.** `serverVersion` in `GET /.well-known/fundroom.json`, the `version` field of `/readyz`, or the container's label.
- **You can tell the two watermark paths apart.** The in-app viewer watermarks *page images*; a download watermarks the *PDF*. They use different code and fail differently, and confusing them wastes the most time.

## 0. Where the font guard actually fires: at boot, not at `/readyz`

**A container that cannot find a font never listens.** `serve` asserts the renderer's font guard once, before it opens the port, and exits non-zero when it fails. So the symptom of a bad image is a container that **restarts in a loop**, with a line on stderr beginning `no font available to librsvg:` and a structured `server.boot_check_failed` log beside it — not a quietly degraded node.

It is checked once because it cannot change while the process runs: the font files are baked into the image and the root filesystem is read-only. And it is checked at boot rather than only reported by `/readyz` because **nothing in the shipped deployment polls `/readyz`**. The container `HEALTHCHECK`, Compose's `healthcheck:` and Caddy's `health_uri` all poll `/healthz`, which reports only "still answering, not draining" — so before this, an image whose font layer regressed answered 200 to every gate it was actually asked, stayed in Caddy's pool, and went on serving blank watermarks.

**Do not "fix" that by repointing those gates at `/readyz`.** They poll liveness on purpose. `/readyz` fails on any Postgres, S3 or SMTP hiccup; a liveness gate pointed at it turns a recoverable dependency outage into a container restart storm (and, because `migrate` and `worker` gate on `service_healthy`, into a stack that will not come back), and a Caddy upstream check pointed at it replaces the app's own 503-with-a-diagnostic-body with a bare 502. The reasoning is recorded beside each of the three gates.

`/readyz` still reports the `render` check, for whoever is already looking there. What it can now tell you that boot cannot is that the check *stopped* passing — which, for a static property, means something stranger than a missing font.

**What the guard verifies is logged, not implied.** At boot the renderer emits `render.font_coverage` with two lists, for example:

```
{"event":"render.font_coverage","verified":["latin","latin-supplement","cyrillic","greek","hebrew","arabic","symbols"],"unsupported":["han","kana","hangul"]}
```

That is the shipped image's honest coverage. Read §2.1 before telling a customer their watermarks are fine.

## 1. The `render` readiness check is failing

`/readyz` reports `{"name":"render","status":"fail","detail":"..."}` and the node is out of rotation. (If the node never came up at all, you are in §0, not here.)

The check compares each probe glyph against **U+0378 — an unassigned code point no font can have a glyph for**, so whatever the renderer draws for it *is* this image's "missing glyph". If `M` lands in the same box, every glyph is a `.notdef` box. That design exists because the failure it catches is invisible to the obvious test: with no font available every glyph renders as the same rectangle, so a "did anything draw?" probe passes happily while the output is meaningless. It deliberately does **not** compare wide glyphs against narrow ones — that measures whether the face is proportional, and failed every monospace-only image while its glyphs rendered perfectly.

1. **If the detail says no font is available to librsvg**, the image is missing its font layer. The runtime image is distroless and ships a font plus a `fontconfig` file explicitly (`/app/fonts`, `FONTCONFIG_FILE`); a custom or rebuilt image that drops that layer produces this. Verify inside the container:

   ```
   ls /app/fonts            # expect the .ttf and fonts.conf
   echo $FONTCONFIG_FILE    # expect /app/fonts/fonts.conf
   ```

   Fix by deploying an image built from the project's own `deploy/docker/Dockerfile`. **Do not** work around it by mounting a font at runtime unless you also set `FONTCONFIG_FILE`; fontconfig will not find a font it has not been told about, and the failure is silent.

2. **If the container has a read-only root filesystem** (the reference Compose sets `read_only: true`), fontconfig still needs somewhere to write its cache. The shipped `fonts.conf` points `<cachedir>` at `/tmp`, which the reference Compose mounts as a tmpfs. An install that has removed that tmpfs will see this check fail.

3. **If the detail says a probe timed out**, the check did not fail, it never answered. Every readiness probe has a five-second ceiling (`probeTimeoutMs`), so `/readyz` reports a hang as a failure instead of holding the connection. A renderer that hangs rather than throws is a genuine fault: capture it as in (4).

4. **If the detail is anything else**, it is a genuine renderer fault — treat it as a bug and capture the detail string, the image tag and the architecture before restarting.

## 2. Watermarks are blank boxes in the viewer

The symptom: a page in the in-app viewer is tiled with a faint diagonal grid of **empty rectangles** where the viewer's email, the timestamp and the workspace name should be. It looks watermarked at a glance, which is the dangerous part.

**This is the fontless case above**, seen from the product end. It affects only the *in-app viewer*; watermarked **downloads are unaffected**, because the PDF path embeds its own font rather than asking the host for one.

- **Remediation is to deploy a fixed image and restart. Nothing needs to be purged from object storage.** The stored page renditions are *not* watermarked — the mark is composited per viewer at request time, and the only thing holding a marked image is an in-process cache that dies with the process. There is no corrupted stored object to hunt for.
- **For the compliance record:** page renditions served from an affected build carried no attributable viewer identity. The access log still records who opened what — that evidence is unaffected — but a screenshot taken from an affected build cannot be attributed from the image itself. Whether that needs disclosing is the workspace owner's decision with counsel, not the operator's.
- **Confirm the fix from the product side**, not just from `/readyz`: open a data-room page as a test investor and read the watermark.

### 2.1 The watermark is still boxes, and the font layer is present

**The bundled font has no CJK.** The image ships one face, DejaVu Sans, which covers Latin, Latin-1, Cyrillic, Greek, Hebrew, Arabic and the common currency and arrow symbols — and no Han, Kana or Hangul. A viewer whose email, timestamp or workspace name is written in Japanese, Chinese or Korean gets **hex boxes**, and the mark carries none of the attributable information the control exists for. Measured in the shipped image, `日本語のワークスペース` inks 1 699 px with the font layer against 1 651 px without it: for CJK the layer changes nothing.

This is a known, deliberate scope, not a regression — a CJK face is tens of megabytes and carrying one is an image-size decision nobody has taken. Three consequences for you:

- **It looks correct in development.** macOS renders CJK perfectly through CoreText, so a developer or a support engineer on a laptop cannot reproduce it. This is the same dev/prod divergence that hid the original fontless bug.
- **The node is healthy and stays in rotation**, correctly: `latin` is the only script the guard requires. Check the boot log's `render.font_coverage` — `han`, `kana` and `hangul` will be in `unsupported` — rather than inferring coverage from a green check.
- **For the compliance record it is the §2 statement again, narrowed to those workspaces**: in-viewer page renditions for a CJK workspace carry no attributable viewer identity, on every build including this one. The access log still records who opened what. Watermarked **downloads** are no better off for these scripts — that path draws base-14 Helvetica, which cannot represent them either.

If a workspace needs it, the change is to add a CJK face to `deploy/docker/Dockerfile` and its `fonts.conf`; raise it as a product decision, not as an incident fix.

## 3. A chart is missing from an investor-update email

Update emails embed KPI charts as PNGs served from the portal, addressed by a capability token. In order of likelihood:

1. **The reader's mail client blocks remote images.** Most do, by default. This is expected and is why the same numbers are always present in the email's text — check the plain-text part before investigating anything else. If the numbers are there, nothing is broken.
2. **The image URL returns 404.** The token is expired (they are minted for 180 days), malformed, or names a workspace that no longer exists. The route answers 404 for *every* rejection deliberately, so the status alone will not tell you which — the audit log will. A recipient reading a year-old email getting a 404 is working as designed; the "view on the web" link beside the image is the path forward.
3. **The image renders but is empty of text.** That is section 1: the font layer.

Note that a chart image URL is shared by every recipient who can see the same metrics, so a fetch of it does **not** identify a reader. If you are looking for per-person open data, it is not here and is not meant to be.

## 4. Telling a rendering fault from a document fault

A single document failing while everything else renders is almost never the renderer.

- **The document never finished ingesting.** Check its scan state and rendition rows before anything else; a document still being processed has no page renditions yet.
- **The file is larger than `RENDER_MAX_BYTES`.** The operator ceiling is deliberate; raising it raises worker memory use.
- **The PDF is malformed or encrypted.** PDFium refuses some files that readers open leniently. The upload's probe result will say `unsupported`.
- **PDFium is single-threaded and serialises every call.** Under a burst of first-time views, renders queue rather than fail. Sustained queueing is a capacity signal — scale worker concurrency, do not raise a timeout.

## 5. After any change here

Re-check `/readyz` on every node, not one. The `render` probe is cached for a minute, and the font coverage behind it is measured once per process and remembered — it is a property of the image, not of the moment — so a node that passed before a bad deploy can keep reporting `ok`. Restart it if you need a definitive answer; a restart is also the definitive answer, because a fontless image will not come back up (§0).
