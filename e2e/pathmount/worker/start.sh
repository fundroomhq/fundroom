#!/bin/sh
# Assemble workerd's config in a writable scratch dir: the capnp `embed` of the edge's CA root has
# to name a file next to the config, and that root only exists once the edge has started
# (compose.pathmount.yaml orders this container after it).
set -eu
dir=/tmp/workerd
mkdir -p "$dir"
cp /srv/worker/config.capnp /srv/worker/harness.js /srv/worker/seed-host-mount.js "$dir/"
cp /edge-ca/root.crt "$dir/edge-root.crt"
exec workerd serve "$dir/config.capnp" --verbose
