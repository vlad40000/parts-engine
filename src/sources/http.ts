import type { FetchResult, Fetcher } from "./types";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";

type HostGate = { active: number; last: number; queue: Array<() => void> };
const gates = new Map<string, HostGate>();

/**
 * Per-host politeness gate: at most `concurrency` requests in flight per supplier
 * host, with `minGapMs` between request starts. Lives per serverless instance,
 * which is enough at batch sizes of 10.
 */
async function acquire(host: string, concurrency: number, minGapMs: number): Promise<() => void> {
  const gate = gates.get(host) ?? { active: 0, last: 0, queue: [] };
  gates.set(host, gate);
  if (gate.active >= concurrency) await new Promise<void>((resolve) => gate.queue.push(resolve));
  gate.active += 1;
  const wait = gate.last + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  gate.last = Date.now();
  return () => {
    gate.active -= 1;
    gate.queue.shift()?.();
  };
}

export function createFetcher(opts: { concurrency?: number; minGapMs?: number; timeoutMs?: number } = {}): Fetcher {
  const concurrency = opts.concurrency ?? 2;
  const minGapMs = opts.minGapMs ?? 600;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return async (url: string): Promise<FetchResult> => {
    const host = new URL(url).host;
    const release = await acquire(host, concurrency, minGapMs);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9"
        }
      });
      const html = res.ok ? await res.text() : "";
      return { ok: res.ok, status: res.status, finalUrl: res.url || url, html };
    } catch (error) {
      return { ok: false, status: 0, finalUrl: url, html: error instanceof Error ? error.message : "fetch failed" };
    } finally {
      release();
    }
  };
}

export function priceNumber(text: string): number | null {
  const m = text.replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
