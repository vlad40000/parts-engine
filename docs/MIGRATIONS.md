# Database migrations

`npm run db:migrate` (`scripts/migrate.mjs`) applies `drizzle/` migrations to `DATABASE_URL`, either Neon or `pglite:<dir>` for local trials.

## How the runner works

- **Pending selection matches drizzle's migrators.** Migrations run in journal order. A migration is pending when its journal `when` is newer than the latest `created_at` in `drizzle.__drizzle_migrations`. Each history row stores the SHA-256 of the `.sql` file and the journal `when`.
- **One transaction per run.** Every pending statement and history row is sent as a single transaction. On Neon this uses the driver's `transaction()`: one HTTP request that commits or rolls back as a unit. On PGlite it uses `PGlite.transaction()`. If any statement or history insert fails, no schema objects or history rows from the run remain, and a retry starts clean. Drizzle's `neon-http` migrator is not used: it auto-commits each statement and writes history last, so a failure partway leaves objects without history, and the retry fails with `42P07`.
- **`--plan`** prints the latest recorded migration and each pending migration's tag, SHA-256, statement count and `when`. It is read-only and does not create the history schema or table.
- **`--expect <tag>=<sha256>[,…]`** applies only if the pending list is exactly that list, in that order. Otherwise it exits with status 1 before writing anything.
- Every statement must be valid inside a transaction. For example, `CREATE INDEX CONCURRENTLY` and `VACUUM` are not supported. Keep migrations small enough for a single Neon HTTP request.
- History hashes are SHA-256 hashes of the file bytes as checked out. Apply production migrations from an LF checkout (`core.autocrlf=false`). Production rows 0000–0002 hold hashes of CRLF renderings. That is expected and does not affect selection, which uses `created_at` only.

## Production release procedure

Run this only with the owner's explicit authorization for the specific commit and migrations. Never run plain `npm run db:migrate` against production.

1. Create a clean LF checkout of the reviewed commit, and confirm `HEAD` is the reviewed SHA:
   `git -c core.autocrlf=false worktree add --detach ../pe-release-<date> <reviewed-sha>`, then `git rev-parse HEAD` and `npm ci`.
2. Confirm each pending file's SHA-256 matches the reviewed value: `sha256sum drizzle/<tag>.sql`.
3. Supply `DATABASE_URL` through the environment without echoing, logging or committing it. Then run
   `node scripts/migrate.mjs --plan`. It must report the expected latest migration and exactly the reviewed pending list.
4. Apply with that list pinned:
   `node scripts/migrate.mjs --expect <tag>=<sha256>[,<tag>=<sha256>…]`.
5. Run `--plan` again. It must report the last applied tag and `No pending migrations.`
6. If step 4 fails, nothing from the run was committed. Do not repair history rows or drop objects. Record the error, run `--plan` again, and report back before retrying.

Rehearse the same commands against a disposable database first, for example `DATABASE_URL=pglite:<temp dir>` or a disposable Neon branch.
