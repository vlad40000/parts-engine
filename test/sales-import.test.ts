import { describe, expect, it } from "vitest";
import { parseCsvRecords } from "@/src/lib/csv";
import { mapSaleRows, saleDate } from "@/src/lib/sales-import";

const csv = (text: string) => mapSaleRows(parseCsvRecords(text));

describe("Roadrunner sales CSV contract", () => {
  it("maps the contract columns and canonicalizes MPNs with D1, keeping the display text", () => {
    const res = csv([
      "mpn,source_event_id,sold_at,quantity,item_price,listed_at",
      " w11-165528 ,ORD-1,2026-09-11,2,$120.00,2026-09-01"
    ].join("\n"));
    expect(res.rows).toEqual([{
      mpnCanonical: "W11165528", mpnDisplay: "w11-165528", sourceEventId: "ORD-1", soldAt: "2026-09-11",
      quantity: 2, itemPrice: 120, listedAt: "2026-09-01", daysToSell: 10, daysToSellSource: "derived"
    }]);
    expect(res.skipped).toEqual([]);
  });

  it("never reads purchaser columns, even when present", () => {
    const res = csv([
      "Buyer Name,mpn,Buyer Username,source_event_id,Ship To Address,Buyer Email,Buyer Phone,Ship To ZIP,Payment Method,sold_at,quantity,item_price,listed_at",
      "Example Buyer,W10006355,example_user,ORD-2,1 Example St,buyer@example.com,000-000-0000,00000,card,2026-10-01,1,45,"
    ].join("\n"));
    expect(res.rows).toHaveLength(1);
    expect(Object.keys(res.rows[0]).sort()).toEqual(
      ["daysToSell", "daysToSellSource", "itemPrice", "listedAt", "mpnCanonical", "mpnDisplay", "quantity", "soldAt", "sourceEventId"]
    );
    const stored = JSON.stringify(res.rows);
    for (const pii of ["Example Buyer", "example_user", "Example St", "buyer@example.com", "000-000-0000", "00000", "card"]) {
      expect(stored).not.toContain(pii);
    }
    expect(res.ignoredColumns).toEqual(["Buyer Name", "Buyer Username", "Ship To Address", "Buyer Email", "Buyer Phone", "Ship To ZIP", "Payment Method"]);
  });

  it("skips rows with no usable MPN or no stable event reference, and reports why", () => {
    const res = csv([
      "mpn,source_event_id,sold_at,quantity,item_price,listed_at",
      "---,ORD-3,2026-10-01,1,10,",
      "W10006355,,2026-10-01,1,10,",
      "W10006355,ORD-4,2026-10-01,1,10,",
      "W10006355,ORD-4,2026-10-02,1,10,",
      "W10006355,ORD-5,not a date,1,10,",
      "W10006355,ORD-6,2026-10-01,0,10,",
      "W10006355,ORD-7,2026-10-01,1.5,10,",
      "W10006355,ORD-8,2026-10-01,1,abc,"
    ].join("\n"));
    expect(res.rows.map((r) => r.sourceEventId)).toEqual(["ORD-4"]);
    expect(res.skipped.map((s) => s.line)).toEqual([2, 3, 5, 6, 7, 8, 9]);
    expect(res.skipped[0].reason).toBe("no usable MPN");
    expect(res.skipped[1].reason).toMatch(/no source_event_id/);
    expect(res.skipped[2].reason).toMatch(/duplicate/);
  });

  it("keeps unknowns unknown: blank price and no listed date stay null, never zero", () => {
    const res = csv([
      "mpn,source_event_id,sold_at,quantity,item_price,listed_at",
      "W10006355,ORD-9,2026-10-01,1,,",
      "W10006355,ORD-10,2026-10-01,1,0,2026-10-05"
    ].join("\n"));
    expect(res.rows[0]).toMatchObject({ itemPrice: null, listedAt: null, daysToSell: null, daysToSellSource: null });
    // Listed after sold is contradictory: listed_at is kept, nothing is derived from it.
    expect(res.rows[1]).toMatchObject({ itemPrice: 0, listedAt: "2026-10-05", daysToSell: null, daysToSellSource: null });
  });

  it("uses a supplied days_to_sell over deriving it", () => {
    const res = csv("mpn,source_event_id,sold_at,quantity,item_price,listed_at,days_to_sell\nW10006355,ORD-11,2026-10-01,1,40,2026-09-01,7");
    expect(res.rows[0]).toMatchObject({ daysToSell: 7, daysToSellSource: "supplied" });
  });

  it("reports missing required contract columns instead of guessing", () => {
    const res = csv("part,order,date\nW10006355,1,2026-10-01");
    expect(res.rows).toEqual([]);
    expect(res.missingColumns).toEqual(["mpn", "source_event_id", "sold_at", "quantity", "item_price"]);
  });

  it("reads calendar dates without timezone drift and rejects impossible ones", () => {
    expect(saleDate("2026-10-05")).toBe("2026-10-05");
    expect(saleDate("2026-10-05T23:30:00-07:00")).toBe("2026-10-05");
    expect(saleDate("10/5/2026")).toBe("2026-10-05");
    expect(saleDate("2026-02-30")).toBeNull();
    expect(saleDate("Oct 5")).toBeNull();
    expect(saleDate("")).toBeNull();
  });
});
