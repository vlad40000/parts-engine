import type { PGlite } from "@electric-sql/pglite";
import type { NeonQueryFunction } from "@neondatabase/serverless";

export type Migration = { tag: string; sql: string[]; bps: boolean; folderMillis: number; hash: string };
export type Statement = { text: string; params: unknown[] };
export type MigrationDb = {
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  transaction(statements: Statement[]): Promise<unknown>;
};

export function readMigrations(migrationsFolder: string): Migration[];
export function inspectMigrations(db: MigrationDb, migrations: Migration[]): Promise<{ latestCreatedAt: number | null; pending: Migration[] }>;
export function transactionStatements(pending: Migration[]): Statement[];
export function parseExpectation(value: string): string[];
export function applyMigrations(db: MigrationDb, migrations: Migration[], options?: { expect?: string[] }): Promise<Migration[]>;
export function neonExecutor(sql: NeonQueryFunction<false, false>): MigrationDb;
export function pgliteExecutor(client: PGlite): MigrationDb;
