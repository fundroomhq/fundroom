# workerd — Cloudflare's open-source Workers runtime, the same one production runs — for the
# path-mount e2e stack. Only the pinned binary goes into the image; the recipe, the harness and
# the config are mounted read-only by compose.pathmount.yaml. Built at `up --build` time and never
# tagged beyond the Compose project's own name.
FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS fetch
WORKDIR /opt/workerd
# Exact version, no range: the npm package only carries the platform binary for this runner.
RUN npm install --no-save --no-audit --no-fund workerd@1.20260918.1 \
 && cp "$(node -p 'require("workerd").default')" /opt/workerd/workerd \
 && /opt/workerd/workerd --version

FROM node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
COPY --from=fetch /opt/workerd/workerd /usr/local/bin/workerd
USER node
ENTRYPOINT ["/bin/sh", "/srv/worker/start.sh"]
