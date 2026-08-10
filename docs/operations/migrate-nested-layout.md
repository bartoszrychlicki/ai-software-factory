# Migrating an existing host from the nested layout

Fresh clones need no migration. This applies only to a machine that previously
ran the factory from `./ai-factory` and therefore keeps `.env`, local YAML and
SQLite state there.

The migration is deliberately copy-only: it does not delete the old directory
and it refuses to overwrite root-level state.

1. Inspect what would be copied:

   ```shell
   bash ops/migrate-from-nested-layout.sh --check
   ```

2. Wait until no execution-stage job is active. Stop both launchd services so
   the SQLite files are not being written.

3. Copy the state:

   ```shell
   bash ops/migrate-from-nested-layout.sh --apply
   npm run doctor
   ```

4. Install the root-level service with `bash ops/install-launchd.sh`. Its own
   preflight checks active and suspended runs before rebuilding and restarting.

5. Verify Studio, `/api/workflows`, poller logs and the lifecycle database
   before considering removal of the ignored old directory. Removal is a
   separate destructive action and is not part of this migration.
