import "server-only";
import * as schema from "./schema";
import type { Db } from "./types";

let cached: Promise<Db> | null = null;

/**
 * DATABASE_URL = Neon connection string in production.
 * DATABASE_URL = "pglite:./.pglite" runs an embedded Postgres for local trials
 * (run `npm run db:migrate` first either way).
 */
export function getDb(): Promise<Db> {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured.");
  cached = (async () => {
    if (url.startsWith("pglite:")) {
      const { PGlite } = await import("@electric-sql/pglite");
      const { drizzle } = await import("drizzle-orm/pglite");
      return drizzle(new PGlite(url.slice("pglite:".length)), { schema }) as unknown as Db;
    }
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    return drizzle(neon(url), { schema }) as unknown as Db;
  })();
  return cached;
}

export function hasDatabase(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
