---
"@fundroom/module-data-room": patch
"@fundroom/server": patch
---

Logical dumps of the database now restore as written. Data-room migration 0008 recreates the two commit-time location triggers from 0006 so their `WHEN` compares the `ltree` paths as text: `pg_dump` cannot schema-qualify the operator behind `IS DISTINCT FROM`, so every `pg_restore --exit-on-error` and every `psql -v ON_ERROR_STOP=1` restore stopped at `operator does not exist: public.ltree = public.ltree`. 0008 drops the old triggers with `IF EXISTS`, so it also heals a database restored from an older dump without stopping on errors, which arrives without them. A new integration test dumps the whole product database (every module, pg-boss, a seeded workspace, data-room rows) and the directory database in custom and plain format, restores each into an empty database, and checks the schema, every table's row count and the triggers. Dumps taken before this migration still carry the old triggers and still need the restore-time workaround (`search_path` set to `public`), as described in the backup-and-restore runbook.
