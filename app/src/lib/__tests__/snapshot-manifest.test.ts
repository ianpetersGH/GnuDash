import { describe, expect, it } from "vitest";
import { generateDemoData } from "@/lib/demo-data";
import { buildConsolidatedData, parseSnapshotManifest, type SnapshotManifest } from "@/lib/snapshot-manifest";

const digest = "a".repeat(64);
const manifest: SnapshotManifest = {
  schema_version: 1,
  generated_at: "2026-09-13T12:00:00Z",
  refresh_seconds: 60,
  books: [
    { id: "personal", label: "Personal", scope: "personal", url: "/snapshots/personal.gnucash", generated_at: "2026-09-13T12:00:00Z", sha256: digest, size_bytes: 100, integrity: "ok", source_engine: "sqlite-online-backup" },
    { id: "business", label: "LLC", scope: "business", url: "/snapshots/business.gnucash", generated_at: "2026-09-13T12:00:00Z", sha256: digest, size_bytes: 100, integrity: "ok", source_engine: "sqlite-online-backup" },
  ],
  consolidation: { policy: "explicit-only", eliminations: [], qualification_notes: [] },
  operational: { failed_imports: null, stale_feeds: null, snapshot_failures: 0, manual_valuation_warn_days: 45 },
};

describe("snapshot manifest contract", () => {
  it("accepts exactly one validated personal and LLC snapshot", () => {
    expect(parseSnapshotManifest(manifest).books.map((book) => book.id)).toEqual(["personal", "business"]);
  });

  it("rejects traversal and duplicate book identities", () => {
    const bad = structuredClone(manifest) as SnapshotManifest;
    bad.books[1].id = "personal";
    bad.books[1].scope = "personal";
    bad.books[1].url = "/snapshots/../private.gnucash";
    expect(() => parseSnapshotManifest(bad)).toThrow();
  });

  it("does not infer eliminations and visibly qualifies the sum", () => {
    const personal = generateDemoData();
    const business = { ...generateDemoData(), currency: personal.currency, currentNetWorth: 123 };
    const result = buildConsolidatedData(personal, business, manifest);
    expect(result.bridge.publication).toBe("qualified");
    expect(result.bridge.verifiedNetWorthEliminations).toBe(0);
    expect(result.data.currentNetWorth).toBe(personal.currentNetWorth + 123);
    expect(result.bridge.qualificationNotes.join(" ")).toMatch(/No cross-book elimination evidence/);
  });

  it("applies only explicit verified bridge entries", () => {
    const withEliminations = structuredClone(manifest);
    withEliminations.consolidation.eliminations = [
      { id: "verified", metric: "net_worth", amount: -25, currency: "USD", status: "verified", rationale: "synthetic paired event", effective_month: "2026-01" },
      { id: "pending", metric: "net_worth", amount: -999, currency: "USD", status: "pending", rationale: "not yet paired", effective_month: "2026-01" },
    ];
    const personal = { ...generateDemoData(), currency: "USD", currentNetWorth: 100 };
    const business = { ...generateDemoData(), currency: "USD", currentNetWorth: 50 };
    const result = buildConsolidatedData(personal, business, withEliminations);
    expect(result.data.currentNetWorth).toBe(125);
    expect(result.bridge.unresolvedEliminations).toHaveLength(1);
    expect(result.bridge.publication).toBe("qualified");
  });
});
