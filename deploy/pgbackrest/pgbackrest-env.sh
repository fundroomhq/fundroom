#!/bin/sh
# Installed as /usr/local/bin/pgbackrest in deploy/docker/postgres-pgbackrest.Dockerfile.
#
# pgBackRest is configured entirely through PGBACKREST_* environment variables (set by
# deploy/compose/compose.backup.yaml on both the db and the pgbackrest services). Compose passes
# `${VAR:-}` through as an empty string, which pgBackRest rejects, so this wrapper:
#   1. resolves <SECRET>_FILE=/path into <SECRET> for the secret options listed in
#      SECRET_OPTIONS (Docker secrets, same convention as the app's NAME_FILE keys) and drops the
#      _FILE variable, which pgBackRest would otherwise reject as an unknown option. It is an
#      explicit list because real pgBackRest options also end in -file (log-level-file,
#      repo1-host-cert-file, …) and must pass through untouched;
#   2. unsets every PGBACKREST_* variable that is empty, so "unset in .env" means "default";
#   3. execs the real binary with the original arguments.
# Postgres' archive_command calls it too, so keep it POSIX sh and quiet on stdout.
set -eu

SECRET_OPTIONS="PGBACKREST_REPO1_CIPHER_PASS PGBACKREST_REPO1_S3_KEY PGBACKREST_REPO1_S3_KEY_SECRET"

for target in $SECRET_OPTIONS; do
  name=${target}_FILE
  eval "path=\${$name:-}"
  unset "$name"
  [ -n "$path" ] || continue
  if [ ! -r "$path" ]; then
    echo "pgbackrest-env: $name points at unreadable file $path" >&2
    exit 1
  fi
  # $(...) drops trailing newlines, which secret files usually end with.
  value=$(cat "$path")
  export "$target=$value"
done

for name in $(env | sed -n 's/^\(PGBACKREST_[A-Z0-9_]*\)=$/\1/p'); do
  unset "$name"
done

exec /usr/local/libexec/pgbackrest "$@"
