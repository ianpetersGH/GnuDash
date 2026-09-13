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

  it("keeps consolidated identities, adjustments, closing variants, and investment history complete", () => {
    const withEliminations = structuredClone(manifest);
    withEliminations.consolidation.eliminations = [
      { id: "income", metric: "income", amount: -5, currency: "USD", status: "verified", rationale: "synthetic paired income", effective_month: "2026-01" },
      { id: "expense", metric: "expenses", amount: -3, currency: "USD", status: "verified", rationale: "synthetic paired expense", effective_month: "2026-01" },
    ];
    const base = generateDemoData();
    const personal = {
      ...base,
      currency: "USD",
      hasClosingTransactions: true,
      cashFlowSeries: [{ month: "2026-01", income: 100, expenses: 40, net: 60 }],
      cashFlowSeriesExcludingClosing: [{ month: "2026-01", income: 90, expenses: 30, net: 60 }],
      monthlyIncomeByCategory: [{ month: "2026-01", category: "Sales", fullPath: "Sales", pathParts: ["Sales"], amount: 100 }],
      monthlyExpensesByCategory: [{ month: "2026-01", category: "Travel", fullPath: "Travel", pathParts: ["Travel"], amount: 40 }],
      monthlyCashInflowByCategory: [{ month: "2026-01", category: "Sales", fullPath: "Sales", pathParts: ["Sales"], amount: 100 }],
      monthlyCashOutflowByCategory: [{ month: "2026-01", category: "Travel", fullPath: "Travel", pathParts: ["Travel"], amount: 40 }],
      investmentValueSeries: [{ month: "2026-01", ticker: "FUND", value: 10, costBasis: 8 }],
    };
    const business = {
      ...base,
      currency: "USD",
      hasClosingTransactions: false,
      cashFlowSeries: [{ month: "2026-01", income: 50, expenses: 20, net: 30 }],
      monthlyIncomeByCategory: [{ month: "2026-01", category: "Sales", fullPath: "Sales", pathParts: ["Sales"], amount: 50 }],
      monthlyExpensesByCategory: [{ month: "2026-01", category: "Travel", fullPath: "Travel", pathParts: ["Travel"], amount: 20 }],
      monthlyCashInflowByCategory: [{ month: "2026-01", category: "Sales", fullPath: "Sales", pathParts: ["Sales"], amount: 50 }],
      monthlyCashOutflowByCategory: [{ month: "2026-01", category: "Travel", fullPath: "Travel", pathParts: ["Travel"], amount: 20 }],
      investmentValueSeries: [{ month: "2026-02", ticker: "OTHER", value: 20, costBasis: 15 }],
    };

    const { data } = buildConsolidatedData(personal, business, withEliminations);
    expect(data.cashFlowSeries).toEqual([{ month: "2026-01", income: 145, expenses: 57, net: 88 }]);
    expect(data.cashFlowSeriesExcludingClosing).toEqual([{ month: "2026-01", income: 135, expenses: 47, net: 88 }]);
    expect(data.monthlyIncomeByCategory.map((row) => row.category)).toEqual(expect.arrayContaining([
      "[Personal] Sales", "[LLC] Sales", "[Consolidation] Verified adjustments",
    ]));
    expect(data.monthlyExpensesByCategory.map((row) => row.fullPath)).toEqual(expect.arrayContaining([
      "personal:Travel", "business:Travel", "consolidation:verified-expenses-adjustments",
    ]));
    expect(data.monthlyIncomeByCategoryExcludingClosing).toBeDefined();
    expect(data.investmentValueSeries.filter((row) => row.ticker === "FUND").map((row) => row.month)).toEqual(["2026-01", "2026-02"]);
    expect(data.investmentValueSeries.find((row) => row.ticker === "FUND" && row.month === "2026-02")?.value).toBe(10);
  });
});
