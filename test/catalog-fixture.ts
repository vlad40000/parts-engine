import { readFileSync } from "node:fs";
import path from "node:path";
import type { Fetcher, FetchResult } from "@/src/sources/types";
export const captures: Array<FetchResult & { url: string }> = JSON.parse(readFileSync(path.join(__dirname, "fixtures/alternate-suppliers/catalogs.json"), "utf8")).responses;
export function catalogFetcher(change?: (r: FetchResult, url: string) => FetchResult): { fetcher: Fetcher; calls: string[] } {
  const calls: string[] = [];
  return { calls, fetcher: async (url) => {
    calls.push(url);
    const r = captures.find((c) => c.url === url);
    if (!r) throw new Error(`Unexpected fixture request: ${url}`);
    return change ? change({ ...r }, url) : { ...r };
  } };
}
