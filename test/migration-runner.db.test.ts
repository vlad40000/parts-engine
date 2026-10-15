import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { neon, neonConfig } from "@neondatabase/serverless";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { applyMigrations, inspectMigrations, neonExecutor, readMigrations, transactionStatements, type Migration } from "../scripts/migration-runner.mjs";

const folder = path.join(__dirname, "..", "drizzle");
const migrations = readMigrations(folder);
const last = migrations.at(-1)!;
const SETUP = 2; // history schema and table statements that open every apply transaction
type Wire = { query: string; params: unknown[] };

/** Stand-in for Neon's HTTP /sql endpoint over PGlite, honoring its contract: a single query
 * auto-commits; a {queries} batch from transaction() commits or rolls back as one unit. */
function neonEndpoint(pg: PGlite) {
  const singles: Wire[] = [], transactions: Wire[][] = [];
  let failAfter: ((q: Wire) => boolean) | null = null;
  const text = (v: unknown) => v == null ? null : typeof v === "boolean" ? (v ? "t" : "f")
    : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  const run = async (target: PGlite | Transaction, q: Wire) => {
    const result = await target.query<unknown[]>(q.query, q.params, { rowMode: "array" });
    if (failAfter?.(q)) throw Object.assign(new Error("injected failure after statement"), { code: "XX000" });
    return { command: "", rowCount: result.affectedRows ?? result.rows.length, fields: result.fields, rows: result.rows.map((r) => r.map(text)) };
  };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchFunction = async (_endpoint: string, init: { body: string; headers: Record<string, string> }) => {
    expect(init.headers["Neon-Connection-String"]).toMatch(/^postgres/);
    const body = JSON.parse(init.body) as Wire | { queries: Wire[] };
    try {
      if (!("queries" in body)) { singles.push(body); return reply(200, await run(pg, body)); }
      transactions.push(body.queries);
      return reply(200, { results: await pg.transaction(async (tx) => { const out = []; for (const q of body.queries) out.push(await run(tx, q)); return out; }) });
    } catch (error) {
      const e = error as { message: string; code?: string };
      return reply(400, { message: e.message, code: e.code });
    }
  };
  const db = () => { neonConfig.fetchFunction = fetchFunction; return neonExecutor(neon("postgresql://synthetic:synthetic@neon-contract.invalid/neondb")); };
  return { db, singles, transactions, failAfter: (f: typeof failAfter) => { failAfter = f; } };
}
const wire = (pending: Migration[]) => transactionStatements(pending).map((s) => ({ query: s.text, params: s.params.map(String) }));

// text, not Postgres's 63-byte name type, so long qualified names cannot truncate into sort ties.
const catalog = async (pg: PGlite) => (await pg.query(`
  select 'schema' kind, nspname::text name, '' detail from pg_namespace where nspname not like 'pg\\_%' and nspname <> 'information_schema'
  union all select 'type', n.nspname||'.'||t.typname, t.typtype::text from pg_type t join pg_namespace n on n.oid=t.typnamespace
    where t.typtype in ('e','d') and n.nspname not in ('pg_catalog','information_schema')
  union all select 'column', table_schema||'.'||table_name||'.'||column_name, concat_ws(' ',data_type,column_default,is_nullable)
    from information_schema.columns where table_schema not in ('pg_catalog','information_schema')
  union all select 'constraint', conrelid::regclass::text||'.'||conname, pg_get_constraintdef(c.oid) from pg_constraint c
    join pg_namespace n on n.oid=c.connamespace where n.nspname not in ('pg_catalog','information_schema')
  union all select 'index', schemaname||'.'||indexname, indexdef from pg_indexes where schemaname not in ('pg_catalog','information_schema')
  union all select 'sequence', sequence_schema||'.'||sequence_name, '' from information_schema.sequences
  order by 1,2,3`)).rows;
const history = async (pg: PGlite) => (await pg.query<{ present: boolean }>(`select to_regclass('drizzle.__drizzle_migrations') is not null as present`)).rows[0].present
  ? (await pg.query(`select hash, created_at::text from drizzle.__drizzle_migrations order by id`)).rows : [];
const rows = (list: Migration[]) => list.map((m) => ({ hash: m.hash, created_at: String(m.folderMillis) }));
/** A database built by drizzle's own migrator, as production was, holding the first `count` migrations. */
async function migratedThrough(count: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pe-migrations-"));
  fs.cpSync(folder, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  fs.writeFileSync(journalPath, JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) }));
  const pg = new PGlite();
  await migrate(drizzle(pg), { migrationsFolder: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  return pg;
}

let reference: PGlite, empty: unknown[];
const open: PGlite[] = [];
beforeAll(async () => {
  reference = await migratedThrough(migrations.length); open.push(reference);
  const blank = new PGlite(); open.push(blank); empty = await catalog(blank);
}, 120_000);
afterAll(async () => { for (const pg of open) await pg.close(); });

describe("Neon HTTP contract used by the migration runner", () => {
  it("auto-commits separate queries but rolls back a failed transaction as a whole", async () => {
    const pg = new PGlite(); open.push(pg);
    const endpoint = neonEndpoint(pg), db = endpoint.db();
    await db.query("create table separate_one (x int)");
    await expect(db.query("select 1/0")).rejects.toThrow("division by zero");
    await expect(db.transaction([{ text: "create table batched_one (x int)", params: [] }, { text: "select 1/0", params: [] }])).rejects.toThrow("division by zero");
    expect((await pg.query(`select to_regclass('separate_one') is not null a, to_regclass('batched_one') is not null b`)).rows).toEqual([{ a: true, b: false }]);
  });
});

describe("atomic migration runner over the Neon driver", () => {
  it("applies every migration to a fresh database in one transaction, matching drizzle's schema and history", async () => {
    const pg = new PGlite(); open.push(pg);
    const endpoint = neonEndpoint(pg), db = endpoint.db();
    expect(await inspectMigrations(db, migrations)).toEqual({ latestCreatedAt: null, pending: migrations });
    expect(await catalog(pg)).toEqual(empty); // inspection wrote nothing
    expect(await applyMigrations(db, migrations)).toEqual(migrations);
    expect(endpoint.transactions).toEqual([wire(migrations)]);
    expect(await catalog(pg)).toEqual(await catalog(reference));
    expect(await history(pg)).toEqual(rows(migrations));

    const sent = endpoint.singles.length;
    expect(await applyMigrations(db, migrations)).toEqual([]);
    expect(endpoint.transactions).toHaveLength(1);
    expect(endpoint.singles.slice(sent).map((q) => q.query.split(" ")[0])).toEqual(["select", "select"]);
    expect(await history(pg)).toEqual(rows(migrations));
  }, 120_000);

  describe(`existing database through ${migrations.at(-2)?.tag}`, () => {
    let pg: PGlite, endpoint: ReturnType<typeof neonEndpoint>, before: { catalog: unknown[]; history: unknown[] };
    beforeAll(async () => {
      pg = await migratedThrough(migrations.length - 1); open.push(pg);
      // Production's earliest history rows hold CRLF-rendered hashes; selection must use created_at only.
      await pg.query(`update drizzle.__drizzle_migrations set hash = 'crlf-rendering-' || id`);
      endpoint = neonEndpoint(pg);
      before = { catalog: await catalog(pg), history: await history(pg) };
    }, 120_000);

    it(`plans only ${last.tag}`, async () => {
      expect(await inspectMigrations(endpoint.db(), migrations)).toEqual({ latestCreatedAt: migrations.at(-2)!.folderMillis, pending: [last] });
    });
    it.each([
      ...last.sql.map((statement, i) => [`statement ${i + 1} of ${last.sql.length}`, (q: Wire) => q.query === statement] as const),
      ["history insert", (q: Wire) => q.query.startsWith(`insert into "drizzle"."__drizzle_migrations"`) && q.params[0] === last.hash] as const
    ])(`a failure after ${last.tag} %s leaves no objects or history and stays retryable`, async (_label, at) => {
      const sent = endpoint.transactions.length;
      endpoint.failAfter(at);
      await expect(applyMigrations(endpoint.db(), migrations)).rejects.toThrow("injected failure");
      endpoint.failAfter(null);
      expect(endpoint.transactions.slice(sent)).toEqual([wire([last])]);
      expect(await catalog(pg)).toEqual(before.catalog);
      expect(await history(pg)).toEqual(before.history);
    });
    it("then a retry completes", async () => {
      expect(await applyMigrations(endpoint.db(), migrations)).toEqual([last]);
      expect(await catalog(pg)).toEqual(await catalog(reference));
      expect(await history(pg)).toEqual([...(before.history as object[]), ...rows([last])]);
      expect(await applyMigrations(endpoint.db(), migrations)).toEqual([]);
    });
  });

  it("rolls back every pending migration when the last one fails", async () => {
    const pg = await migratedThrough(migrations.length - 2); open.push(pg);
    const endpoint = neonEndpoint(pg), before = { catalog: await catalog(pg), history: await history(pg) };
    endpoint.failAfter((q) => q.params[0] === last.hash);
    await expect(applyMigrations(endpoint.db(), migrations)).rejects.toThrow("injected failure");
    expect(endpoint.transactions).toEqual([wire(migrations.slice(-2))]);
    expect(endpoint.transactions[0]).toHaveLength(SETUP + migrations.slice(-2).reduce((n, m) => n + m.sql.length + 1, 0));
    expect({ catalog: await catalog(pg), history: await history(pg) }).toEqual(before);
    endpoint.failAfter(null);
    expect(await applyMigrations(endpoint.db(), migrations)).toEqual(migrations.slice(-2));
    expect(await catalog(pg)).toEqual(await catalog(reference));
  }, 120_000);

  it("refuses a pending list that differs from --expect before writing anything", async () => {
    const pg = new PGlite(); open.push(pg);
    const endpoint = neonEndpoint(pg), db = endpoint.db();
    await expect(applyMigrations(db, migrations, { expect: [`${last.tag}=${last.hash}`] })).rejects.toThrow("nothing was applied");
    expect(endpoint.transactions).toEqual([]);
    expect(await catalog(pg)).toEqual(empty);
    expect(await applyMigrations(db, migrations, { expect: migrations.map((m) => `${m.tag}=${m.hash}`) })).toEqual(migrations);
  }, 120_000);
});

describe("db:migrate command on a local PGlite directory", () => {
  const run = promisify(execFile);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pe-migrate-cli-"));
  const cli = (...args: string[]) => run(process.execPath, [path.join(__dirname, "..", "scripts", "migrate.mjs"), ...args], { env: { ...process.env, DATABASE_URL: `pglite:${dir}` } });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("plans without writing, enforces --expect, applies once and reruns as a no-op", async () => {
    const all = migrations.map((m) => `${m.tag}=${m.hash}`).join(",");
    expect((await cli("--plan")).stdout).toContain(`Latest recorded migration: none\nPending migrations (${migrations.length}):\n  ${migrations[0].tag}  sha256=${migrations[0].hash}`);
    await expect(cli("--expect", `${last.tag}=${last.hash}`)).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("nothing was applied") });
    expect((await cli("--plan")).stdout).toContain(`Pending migrations (${migrations.length})`);
    expect((await cli(`--expect=${all}`)).stdout).toContain(`Applied in one transaction (${migrations.length})`);
    expect((await cli()).stdout).toContain("No pending migrations.");
    expect((await cli("--plan")).stdout).toContain(`Latest recorded migration: ${last.tag} (created_at=${last.folderMillis})\nNo pending migrations.`);
  }, 120_000);
});
