import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FleetAgeBandPanel } from "@/src/components/fleet-age-band-panel";
import { DEFAULT_AGE_BANDS } from "@/src/lib/serial-decoder";

describe("Fleet age-band reference panel", () => {
  it("renders closed by default while preserving the matrix and original model links", () => {
    const band = DEFAULT_AGE_BANDS[0];
    const counts: Record<string, number> = Object.fromEntries(
      DEFAULT_AGE_BANDS.map((item) => [item.key, 0])
    );
    counts.total = 2;
    counts.unknown = 1;
    counts[band.key] = 1;
    const html = renderToStaticMarkup(createElement(FleetAgeBandPanel, {
      matrix: [{ type: "Dryer", counts }]
    }));

    expect(html).toMatch(/<details\b/);
    expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|=|>)/);
    expect(html).toContain("<summary");
    expect(html).toContain("Age band");
    expect(html).toContain("(expand)");
    expect(html).toContain("Dryer");
    expect(html).toContain("Machines");
    expect(html).toContain(band.label);
    expect(html).toContain("Unknown");
    expect(html).toContain(`href="/bom?type=Dryer&amp;band=${band.key}"`);
    expect(html).toContain("Click a band count");
  });
});
