// Saves a supplier page's raw HTML so a parser can be written and tested against it.
// Run on your own machine (this needs normal internet access):
//   npm run capture -- partselect https://www.partselect.com/Models/GDT535PSJ2SS/
//   npm run capture -- partsdr https://partsdr.com/appliance-models/dv45h7000ewa2-01-samsung-dryer
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const [supplier, url] = process.argv.slice(2);
if (!supplier || !url) {
  console.error("Usage: npm run capture -- <supplier> <url>");
  process.exit(1);
}
const res = await fetch(url, {
  redirect: "follow",
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9"
  }
});
const html = await res.text();
const slug = new URL(res.url).pathname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "index";
const dir = path.join("test", "fixtures", supplier);
await mkdir(dir, { recursive: true });
const file = path.join(dir, `${slug}.html`);
await writeFile(file, html);
await writeFile(file.replace(/\.html$/, ".json"), JSON.stringify({ requested: url, final: res.url, status: res.status, bytes: html.length, captured: new Date().toISOString() }, null, 2));
console.log(`${res.status} ${res.url}\n→ ${file} (${html.length.toLocaleString()} bytes)`);
