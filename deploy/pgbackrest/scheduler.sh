#!/bin/sh
# pgBackRest scheduler: the entrypoint of the `pgbackrest` sidecar in
# deploy/compose/compose.backup.yaml (installed as /usr/local/bin/pgbackrest-scheduler).
#
# Runs as the postgres uid with the db's data volume mounted read-only and its unix-socket
# directory shared, so `pgbackrest backup` talks to Postgres over the socket and copies files
# straight from the data directory. WAL is pushed by the db container itself (archive_command).
#
# On start: wait for Postgres, `stanza-create` (idempotent: a no-op when the stanza already
# exists and matches this cluster), `check` (forces a WAL switch and waits for it to reach the
# repo, so a broken archive_command fails here, loudly), and a first full backup if the repo has
# none yet, so point-in-time recovery works from day one rather than from the first Sunday.
#
# Then, once a day at BACKUP_TIME (HH:MM, container clock = UTC): a full backup on
# BACKUP_FULL_WEEKDAY (1 = Monday … 7 = Sunday, `date +%u`), a differential on the other days.
# pgBackRest expires old backups and their WAL after each backup according to
# repo1-retention-full (PGBACKREST_REPO1_RETENTION_FULL).
#
# WAL archiving watch: every BACKUP_ARCHIVE_CHECK_INTERVAL seconds (default 60) the scheduler
#   - reads pg_stat_archiver: archiving is failing when the last failure is newer than the last
#     success, and it counts from the last successful archive;
#   - probes the repository with `pgbackrest repo-ls` (read-only), and counts from the first
#     failed probe in the current run of failures. This catches a dead repository even when
#     PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX is set: dropped segments count as "archived" in
#     pg_stat_archiver, which would otherwise hide the outage.
# Once either has lasted BACKUP_ARCHIVE_GRACE seconds (default 300, the RPO), it logs an ERROR on
# every check and marks the container unhealthy; the flag clears on the first check where both
# are fine again. Without this, a broken repository (expired S3 credentials, full disk, …) would
# only show up at the next nightly backup, while pg_wal grows on the database volume.
#
# Health: /tmp/pgbackrest-ready exists once the stanza checks out; /tmp/pgbackrest-failed exists
# while the most recent scheduled backup has failed (removed by the next success);
# /tmp/pgbackrest-archive-failed exists while WAL archiving is failing. The compose healthcheck
# is healthy only with the first and without the other two.
set -u

STANZA=${PGBACKREST_STANZA:-seedhost}
FULL_WEEKDAY=${BACKUP_FULL_WEEKDAY:-7}
BACKUP_TIME=${BACKUP_TIME:-02:30}
INITIAL_FULL=${BACKUP_INITIAL_FULL:-true}
SOCKET=${PGBACKREST_PG1_SOCKET_PATH:-/var/run/postgresql}
PGUSER_=${PGBACKREST_PG1_USER:-postgres}
PGDB_=${PGBACKREST_PG1_DATABASE:-postgres}
ARCHIVE_CHECK_INTERVAL=${BACKUP_ARCHIVE_CHECK_INTERVAL:-60}
ARCHIVE_GRACE=${BACKUP_ARCHIVE_GRACE:-300}
READY=/tmp/pgbackrest-ready
FAILED=/tmp/pgbackrest-failed
ARCHIVE_FAILED=/tmp/pgbackrest-archive-failed

log() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') pgbackrest-scheduler: $*"; }

case "$FULL_WEEKDAY" in [1-7]) ;; *) log "BACKUP_FULL_WEEKDAY must be 1-7, got '$FULL_WEEKDAY'"; exit 64 ;; esac
case "$BACKUP_TIME" in [0-2][0-9]:[0-5][0-9]) ;; *) log "BACKUP_TIME must be HH:MM, got '$BACKUP_TIME'"; exit 64 ;; esac
case "$ARCHIVE_CHECK_INTERVAL$ARCHIVE_GRACE" in *[!0-9]*|'') log "BACKUP_ARCHIVE_CHECK_INTERVAL and BACKUP_ARCHIVE_GRACE must be whole seconds"; exit 64 ;; esac

# One line from pg_stat_archiver: <failing t|f>|<seconds since last success>|<failed_count>|
# <last_failed_wal>|<last_archived_wal>. "Since last success" falls back to stats_reset when
# nothing has archived yet.
archive_status() {
  psql -X -q -A -t -h "$SOCKET" -U "$PGUSER_" -d "$PGDB_" -c "
    select coalesce(last_failed_time > coalesce(last_archived_time, '-infinity'), false),
           floor(extract(epoch from now() - coalesce(last_archived_time, stats_reset)))::bigint,
           failed_count, coalesce(last_failed_wal, ''), coalesce(last_archived_wal, '')
      from pg_stat_archiver"
}

repo_down_since=""
check_archiving() {
  now_s=$(date -u +%s)
  bad=""

  # The listing (a couple of names) is discarded; on failure the output is the ERROR line.
  if probe=$(pgbackrest --log-level-console=error repo-ls "archive/$STANZA" 2>&1); then
    repo_down_since=""
  else
    [ -n "$repo_down_since" ] || repo_down_since=$now_s
    down=$((now_s - repo_down_since))
    if [ "$down" -ge "$ARCHIVE_GRACE" ]; then
      bad="repository unreachable for ${down}s: $(echo "$probe" | tr '\n' ' ')"
    else
      log "WARN: repository probe failed (${down}s, grace ${ARCHIVE_GRACE}s): $(echo "$probe" | tr '\n' ' ')"
    fi
  fi

  if ! status=$(archive_status 2>&1); then
    log "WARN: could not read pg_stat_archiver: $status"
  else
    IFS='|' read -r failing since failed_count failed_wal archived_wal <<EOF
$status
EOF
    if [ "$failing" = "t" ] && [ "$since" -ge "$ARCHIVE_GRACE" ]; then
      bad="${bad:+$bad; }nothing archived for ${since}s, last failed segment $failed_wal, $failed_count failures since stats reset"
    elif [ "$failing" = "t" ]; then
      log "WARN: WAL archiving failed for $failed_wal (${since}s since the last success, grace ${ARCHIVE_GRACE}s)"
    fi
  fi

  if [ -n "$bad" ]; then
    echo "$bad" >"$ARCHIVE_FAILED"
    log "ERROR: WAL archiving is failing (grace ${ARCHIVE_GRACE}s): $bad. pg_wal grows on the db volume until it recovers; the archive-push error is in the db logs."
  elif [ -f "$ARCHIVE_FAILED" ] && [ -z "$repo_down_since" ] && [ "${failing:-f}" != "t" ]; then
    rm -f "$ARCHIVE_FAILED"
    log "WAL archiving recovered: last archived segment ${archived_wal:-unknown}"
  fi
}

trap 'log "stopping"; exit 0' TERM INT
rm -f "$READY" "$FAILED" "$ARCHIVE_FAILED"

until pg_isready -q -h "$SOCKET" -U "$PGUSER_"; do
  log "waiting for Postgres on $SOCKET"
  sleep 2 &
  wait $!
done

# Exit non-zero on setup failures: `restart: unless-stopped` retries, and the container never
# reports healthy, which is the signal an operator needs.
pgbackrest --stanza="$STANZA" stanza-create || { log "stanza-create failed"; exit 1; }
pgbackrest --stanza="$STANZA" check || { log "check failed (is archive_command set on db?)"; exit 1; }

if [ "$INITIAL_FULL" = "true" ] &&
  pgbackrest --stanza="$STANZA" --output=json info | grep -q '"backup":\[\]'; then
  log "repository has no backup yet: taking the initial full backup"
  pgbackrest --stanza="$STANZA" --type=full backup || { log "initial full backup failed"; exit 1; }
fi

touch "$READY"
log "ready: full on weekday $FULL_WEEKDAY, differential on other days, at $BACKUP_TIME UTC"

last_run=""
next_archive_check=0
while :; do
  now=$(date -u +%s)
  if [ "$now" -ge "$next_archive_check" ]; then
    next_archive_check=$((now + ARCHIVE_CHECK_INTERVAL))
    check_archiving
  fi
  today=$(date -u +%F)
  if [ "$(date -u +%H:%M)" = "$BACKUP_TIME" ] && [ "$last_run" != "$today" ]; then
    last_run=$today
    if [ "$(date -u +%u)" = "$FULL_WEEKDAY" ]; then type=full; else type=diff; fi
    log "starting scheduled $type backup"
    if pgbackrest --stanza="$STANZA" --type="$type" backup; then
      rm -f "$FAILED"
      log "scheduled $type backup finished"
    else
      echo "$today $type" >"$FAILED"
      log "ERROR: scheduled $type backup failed; next attempt at the next scheduled time"
    fi
  fi
  sleep 15 &
  wait $!
done
