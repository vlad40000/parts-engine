import { it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as schema from "@/src/db/schema";
import type { Db } from "@/src/db/types";
import { saveModelBom } from "@/src/db/queries";
import { lookupAppliancePartsPros } from "@/src/sources/appliancepartspros";
import type { Fetcher } from "@/src/sources/types";

const dir = process.env.SEED_PGLITE;
it.skipIf(!dir)("seed local pglite with a fixture parts list", async () => {
  const client = new PGlite(dir as string);
  await migrate(drizzle(client), { migrationsFolder: path.join(__dirname, "..", "drizzle") });
  const db = drizzle(client, { schema }) as unknown as Db;
  const model = readFileSync(path.join(__dirname, "fixtures/app/MVWX655DW1-model.html"), "utf8");
  const section = readFileSync(path.join(__dirname, "fixtures/app/MVWX655DW1-top.html"), "utf8");
  const fetcher: Fetcher = async (url) => ({ ok: true, status: 200, finalUrl: url, html: url.includes("search.aspx") ? model : url.includes("top-and-cabinet") ? section : "<html></html>" });
  const r = await lookupAppliancePartsPros({ brand: "Maytag", model: "MVWX655DW1" }, fetcher);
  const { rows, ...meta } = r;
  console.log(await saveModelBom(db, { brandKey: "MAYTAG", modelKey: "MVWX655DW1", brandDisplay: "Maytag", modelDisplay: "MVWX655DW1", result: { status: "found", winner: r, attempts: [meta] } }), rows.length);
  await client.close();
});
