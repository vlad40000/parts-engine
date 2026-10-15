// Plans and applies drizzle/ migrations atomically. Pending selection matches drizzle's own
// migrators: journal order, every migration newer than the latest history row's created_at,
// and history rows of (sha256 of the .sql file, journal "when"). Unlike drizzle-orm/neon-http's
// migrator, which auto-commits each statement, every pending statement and history row is sent
// as one transaction: a failure leaves no partial schema or history, and a retry starts clean.
import fs from "node:fs";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";

const HISTORY = '"drizzle"."__drizzle_migrations"';

/** Journal entries with drizzle's statement split and hash. */
export function readMigrations(migrationsFolder) {
  const { entries } = JSON.parse(fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"));
  return readMigrationFiles({ migrationsFolder }).map((migration, i) => ({ tag: entries[i].tag, ...migration }));
}

/** Read-only: never creates the history schema or table. */
export async function inspectMigrations(db, migrations) {
  const [{ present }] = await db.query(`select to_regclass('${HISTORY}') is not null as "present"`);
  const [latest] = present ? await db.query(`select created_at from ${HISTORY} order by created_at desc limit 1`) : [];
  const latestCreatedAt = latest ? Number(latest.created_at) : null;
  return { latestCreatedAt, pending: migrations.filter((m) => latestCreatedAt === null || latestCreatedAt < m.folderMillis) };
}

/** Everything one apply sends, in order: history table setup, then each migration's statements and history row. */
export function transactionStatements(pending) {
  return [
    { text: 'CREATE SCHEMA IF NOT EXISTS "drizzle"', params: [] },
    { text: `CREATE TABLE IF NOT EXISTS ${HISTORY} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`, params: [] },
    ...pending.flatMap((m) => [
      ...m.sql.map((text) => ({ text, params: [] })),
      { text: `insert into ${HISTORY} ("hash", "created_at") values ($1, $2)`, params: [m.hash, m.folderMillis] }
    ])
  ];
}

/** "tag=sha256,tag=sha256": the exact ordered pending list an operator reviewed. */
export function parseExpectation(value) {
  const items = value.split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.length || items.some((s) => !/^[\w-]+=[a-f0-9]{64}$/.test(s))) {
    throw new Error("--expect must be a comma-separated list of <tag>=<sha256>.");
  }
  return items;
}

export async function applyMigrations(db, migrations, { expect } = {}) {
  const { pending } = await inspectMigrations(db, migrations);
  if (expect) {
    const actual = pending.map((m) => `${m.tag}=${m.hash}`);
    if (actual.join(",") !== expect.join(",")) {
      throw new Error(`Pending migrations differ from --expect; nothing was applied. Pending: ${actual.join(", ") || "none"}.`);
    }
  }
  if (pending.length) await db.transaction(transactionStatements(pending));
  return pending;
}

/** Neon HTTP: transaction() sends all statements in one request that commits or rolls back as a unit.
 * Separate BEGIN/COMMIT requests would not share a session. */
export function neonExecutor(sql) {
  return {
    query: (text, params = []) => sql.query(text, params),
    transaction: (statements) => sql.transaction(statements.map((s) => sql.query(s.text, s.params)))
  };
}

export function pgliteExecutor(client) {
  return {
    query: async (text, params = []) => (await client.query(text, params)).rows,
    transaction: (statements) => client.transaction(async (tx) => {
      for (const s of statements) await tx.query(s.text, s.params);
    })
  };
}
