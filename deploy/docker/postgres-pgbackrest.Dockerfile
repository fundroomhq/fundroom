# syntax=docker/dockerfile:1.7
# hadolint global ignore=DL3002,DL3066
# Postgres 18 + pgBackRest for the Compose backup overlay (Tier 1).
#
# Built locally by deploy/compose/compose.backup.yaml (`build:`); never pushed. The same image
# runs the database (archive_command = pgbackrest archive-push) and the `pgbackrest` scheduler
# sidecar, so both always carry the same pgBackRest version.
#
#   docker compose -f compose.yaml -f compose.backup.yaml build db
#
# pgBackRest is compiled from the pinned release tarball rather than `apk add pgbackrest`:
# Alpine's package depends on Alpine's own `postgresql18` server package, which would put a
# second, different Postgres build (~60 MB) next to the official image's /usr/local one. The
# builder uses the same base, so pgBackRest links against the image's own libpq.
#
# Bumping: PG_IMAGE + PG_DIGEST (index digest: `docker buildx imagetools inspect postgres:<tag>`) and
# PGBACKREST_VERSION + PGBACKREST_SHA256 (sha256 of the GitHub release archive) together.

ARG PG_IMAGE=postgres:18.6-alpine3.24
ARG PG_DIGEST=sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873

# --- build: compile pgBackRest against the image's libpq --------------------------------------
FROM ${PG_IMAGE}@${PG_DIGEST} AS build
ARG PGBACKREST_VERSION=2.59.1
ARG PGBACKREST_SHA256=ca1e75c7490989a2fb39b8266c0f3c518dd3c873ddc0c3a346ca9b5dccc16455
# curl-dev: the image's libpq.pc (PG 18, OAuth) lists libcurl, so pkg-config needs it to resolve libpq.
# hadolint ignore=DL3018
RUN apk add --no-cache build-base meson ninja-build pkgconf \
      bzip2-dev curl-dev libxml2-dev lz4-dev openssl-dev yaml-dev zlib-dev zstd-dev
# wget + sha256sum rather than `ADD --checksum`, which the hadolint bundled with
# hadolint-action@v3.1.0 (2.12) cannot parse.
RUN wget -q -O /tmp/pgbackrest.tar.gz \
      "https://github.com/pgbackrest/pgbackrest/archive/release/${PGBACKREST_VERSION}.tar.gz" \
 && echo "${PGBACKREST_SHA256}  /tmp/pgbackrest.tar.gz" >/tmp/pgbackrest.sha256 \
 && sha256sum -c /tmp/pgbackrest.sha256 \
 && mkdir /src \
 && tar -xzf /tmp/pgbackrest.tar.gz -C /src --strip-components=1 \
 && meson setup /build /src --buildtype=release -Dlibssh2=disabled -Dlibsystemd=disabled \
 && ninja -C /build \
 && strip /build/src/pgbackrest \
 && /build/src/pgbackrest version

# --- runtime: the official image plus one binary and two scripts ------------------------------
FROM ${PG_IMAGE}@${PG_DIGEST}
# libbz2 is the only runtime library the base image does not already ship.
# hadolint ignore=DL3018
RUN apk add --no-cache libbz2 \
 && install -d -o postgres -g postgres -m 0750 /var/lib/pgbackrest /var/log/pgbackrest \
 && install -d -o postgres -g postgres -m 0770 /tmp/pgbackrest \
 && install -d -o postgres -g postgres -m 0700 /var/lib/pgrestore \
 && install -d -m 0755 /etc/pgbackrest
# The real binary lives outside PATH; /usr/local/bin/pgbackrest is the env-cleaning wrapper
# (see deploy/pgbackrest/pgbackrest-env.sh) that Postgres' archive_command and operators call.
COPY --from=build /build/src/pgbackrest /usr/local/libexec/pgbackrest
COPY --chmod=0755 pgbackrest/pgbackrest-env.sh /usr/local/bin/pgbackrest
COPY --chmod=0755 pgbackrest/scheduler.sh /usr/local/bin/pgbackrest-scheduler
RUN pgbackrest version

# Root on purpose, as in the base image: docker-entrypoint.sh starts as root to chown PGDATA and
# the socket dir, then drops to `postgres` (su-exec) before Postgres starts. The pgbackrest
# sidecar and the restore helpers run with `user: postgres` (compose.backup.yaml). The explicit
# USER line exists so the scanner exceptions below can attach to it: Trivy AVD-DS-0002 has no
# line to attach an inline ignore to when USER is simply absent, and it must sit directly above
# the line, so hadolint's DL3002/DL3066 exception is the file-level `global ignore` at the top.
# trivy:ignore:AVD-DS-0002
USER root
