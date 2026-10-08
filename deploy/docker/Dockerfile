# syntax=docker/dockerfile:1.7
# FundRoom image.
#
# One multi-arch image, four commands: `serve` (default: api + web + worker), `migrate`,
# `setup-token`, `seed-demo` (plus `doctor`, `audit`, `openapi`, `version`). Runtime stage is
# distroless (no shell, no package manager), runs as the non-root `nonroot` user, and expects
# a writable volume at /data and a read-only root filesystem (Compose sets both).
#
#   docker build -f deploy/docker/Dockerfile -t fundroom .
#   docker run --rm -e DATABASE_URL=... -e BASE_URL=... -v seedhost-data:/data -p 3000:3000 fundroom
#   (The volume keeps its pre-rename name on purpose: it holds the generated master key, and a
#   new volume name on an upgrade would mean a new, empty /data and a new key.)
#
# Build context is the repository root (see .dockerignore). No build args are needed; CI passes
# FUNDROOM_VERSION (the OCI version label: the release version, or `<version>+git.<sha7>` for edge).

ARG NODE_IMAGE=node:24-slim
# Debian 13: the debian12 variant no longer tracks Node 24 patch releases or Debian security
# updates (it still carries Node 24.14 and an OpenSSL missing a CRITICAL fix that Debian has).
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13:nonroot

# --- build: install the workspace, compile every package and the SPA ---------------------
FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    TURBO_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
# One font face, staged for the runtime stage.
#
# The runtime image is distroless and ships no fonts. sharp's prebuilt libvips carries its own
# librsvg/pango/fontconfig *code*, so compositing an SVG works — but with no font *files* and no
# fontconfig config, librsvg drew every glyph of the data-room watermark as a .notdef box. It did
# so silently, with a plausible ink count, and only in production (macOS falls through to
# CoreText and looks perfect). An embedded data-URI `@font-face` does not rescue it: tested,
# librsvg 2.62.91 ignores it in both woff2 and ttf form.
#
# DejaVu Sans, not Inter: both licences suit an MIT repo (Bitstream Vera + Arev, a permissive
# MIT-style licence, vs OFL-1.1), but DejaVu is in Debian's archive, so the bytes arrive with
# the rest of the build — no release download to pin, checksum and rotate — and it covers Latin,
# Greek, Cyrillic, Hebrew and Arabic. That coverage is the point: a workspace whose name is in
# Cyrillic must not get the same tofu back. We take one face out of the family's twenty rather
# than subsetting by code point, for exactly that reason.
#
# **It does NOT cover CJK, and nothing here does.** A Japanese, Chinese or Korean viewer
# identity or workspace name still renders as a grid of hex boxes in the in-viewer watermark, so
# for those workspaces the mark carries none of the attributable information it exists for —
# measured in this image, `日本語のワークスペース` inks 1 699 px with this layer against 1 651 px
# without it, i.e. unchanged. That is a deliberate scope, not an oversight: a CJK face is tens of
# megabytes. `healthCheck()` reports which scripts the running image actually renders
# (`render.font_coverage` at boot) instead of a bare pass, and docs/runbooks/document-rendering.md
# says what it means operationally. Adding CJK is an image-size decision for whoever owns it.
#
# Sizes, measured rather than estimated (arm64, 2026-09-20): DejaVuSans.ttf is 759 720 B, the
# layer that carries it and the licence file 778 kB, and the whole image unpacks to 591 MB
# (`docker images`). If you change either, re-measure — the numbers here used to be "757 KB" and
# "~300 MB" and both were wrong.
#
# DL3008 (pin apt versions) is waived for this one package on purpose: Debian keeps only the
# current version of a package in a stable suite, so an `=<version>` pin breaks the build on the
# next point release (or base-image suite bump) without making the bytes any more reproducible
# than the base image tag already does. What the font renders is reported at boot instead
# (`render.font_coverage`, see above).
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && mkdir -p /fonts \
    && cp /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf /fonts/ \
    && cp /usr/share/doc/fonts-dejavu-core/copyright /fonts/LICENSE-DejaVu.txt \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# The web build writes "hidden" source maps (no sourceMappingURL comment) for error tooling; they
# are deleted before the dist is copied so the image never ships them (F-32, ASVS 15.2.3; the
# server also answers 404 for any /assets/*.map).
# --ignore-scripts skips the repo's lefthook `prepare` hook (no .git here); the two native
# helpers that do need their postinstall are rebuilt explicitly.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts \
    && pnpm rebuild esbuild @biomejs/biome \
    && pnpm build \
    && pnpm --filter @fundroom/server deploy --legacy --prod --ignore-scripts /out/server \
    && find apps/web/dist -type f -name '*.map' -delete \
    && cp -r apps/web/dist /out/web \
    && cp apps/server/dist/healthcheck.js /out/server/healthcheck.js \
    && mkdir -p /out/data/storage

# --- runtime ---------------------------------------------------------------------------------
FROM ${RUNTIME_IMAGE} AS runtime
ARG FUNDROOM_VERSION=0.0.0
LABEL org.opencontainers.image.title="FundRoom" \
      org.opencontainers.image.description="Self-hostable, embeddable, gated investor-relations portal" \
      org.opencontainers.image.source="https://github.com/fundroomhq/fundroom" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${FUNDROOM_VERSION}"
ENV NODE_ENV=production \
    APP_ENV=prod \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    STORAGE_FS_PATH=/data/storage \
    WEB_DIST_PATH=/app/web \
    TRUST_PROXY=true \
    FONTCONFIG_FILE=/app/fonts/fonts.conf \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out/server /app
COPY --from=build --chown=nonroot:nonroot /out/web /app/web
COPY --from=build --chown=nonroot:nonroot /fonts /app/fonts
# `<cachedir>` MUST be under /tmp: Compose runs this container with `read_only: true` and a
# tmpfs at /tmp (deploy/compose/compose.yaml x-app), so fontconfig's default ~/.cache path is
# unwritable and it would fall back to rescanning on every call. The aliases point every family
# the SVG asks for at the one face we ship, and the append_last rule catches the rest — a
# missing alias would silently mean tofu again, which is the failure this whole layer exists to
# end. `renderVector` (charts) does not depend on any of this: PDFium's WASM embeds base-14.
COPY --chown=nonroot:nonroot <<'FONTSCONF' /app/fonts/fonts.conf
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>/app/fonts</dir>
  <cachedir>/tmp/fontconfig</cachedir>
  <alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>monospace</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>Helvetica</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <alias><family>Arial</family><prefer><family>DejaVu Sans</family></prefer></alias>
  <match target="pattern">
    <edit name="family" mode="append_last"><string>DejaVu Sans</string></edit>
  </match>
</fontconfig>
FONTSCONF

# An empty /data owned by nonroot: a fresh named volume copies this ownership, so the
# generated key, setup token and storage-fs objects can be written without root. Bind
# mounts must be chowned to 65532 by the operator.
COPY --from=build --chown=nonroot:nonroot /out/data /data
VOLUME ["/data"]
EXPOSE 3000
USER nonroot
# Liveness, and deliberately **not** readiness. `healthcheck.js` polls
# `/healthz`, which reports only "is this process still answering and not draining"; `/readyz`
# runs the dependency probes. Pointing this at `/readyz` would make Docker kill and restart the
# container every time Postgres, S3 or SMTP hiccups — a recoverable dependency outage turned
# into a restart storm, and with Compose's `service_healthy` dependencies, a stack that will not
# come back. The one readiness property that *is* fixed for the life of the image — the
# renderer can find a font — is asserted once at boot instead (apps/server/src/readiness.ts
# `assertBootInvariants`): a fontless image exits non-zero and restarts visibly rather than
# answering 200 here while it composites blank watermarks.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/healthcheck.js"]
# `--import` registers the OpenTelemetry ESM hook for pg/undici before anything loads
# (a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set).
ENTRYPOINT ["/nodejs/bin/node", "--import", "/app/dist/instrumentation.js", "/app/dist/cli.js"]
CMD ["serve"]
