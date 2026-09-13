import { describe, expect, it } from "vitest";
import { generateDemoData } from "@/lib/demo-data";
import { buildConsolidatedData, parseSnapshotManifest, type SnapshotManifest } from "@/lib/snapshot-manifest";
import type { DashboardData, ExpenseCategory, MonthlyExpenseByCategory } from "@/lib/types/gnucash";

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

const monthlyCategory = (amount: number): MonthlyExpenseByCategory => ({
  month: "2026-01",
  category: "Leaf",
  fullPath: "Shared:Leaf",
  pathParts: ["Shared", "Leaf"],
  amount,
});

const expenseCategory = (amount: number): ExpenseCategory => ({
  name: "Shared",
  fullPath: "Shared",
  amount,
});

function syntheticData(overrides: Partial<DashboardData>): DashboardData {
  return { ...generateDemoData(), currency: "USD", ...overrides };
}

function sumMonth(rows: MonthlyExpenseByCategory[], month: string): number {
  return rows.filter((row) => row.month === month).reduce((sum, row) => sum + row.amount, 0);
}

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

  it("carries each book's last known net worth across the union month axis", () => {
    const personal = syntheticData({
      netWorthSeries: [
        { month: "2026-01", assets: 120, liabilities: 20, netWorth: 100 },
        { month: "2026-03", assets: 160, liabilities: 30, netWorth: 130 },
      ],
    });
    const business = syntheticData({
      netWorthSeries: [
        { month: "2026-01", assets: 15, liabilities: 5, netWorth: 10 },
        { month: "2026-02", assets: 28, liabilities: 8, netWorth: 20 },
      ],
    });

    expect(buildConsolidatedData(personal, business, manifest).data.netWorthSeries).toEqual([
      { month: "2026-01", assets: 135, liabilities: 25, netWorth: 110 },
      { month: "2026-02", assets: 148, liabilities: 28, netWorth: 120 },
      { month: "2026-03", assets: 188, liabilities: 38, netWorth: 150 },
    ]);
  });

  it("namespaces category rows, breakdowns, transactions, and color keys by book", () => {
    const transaction = {
      date: "2026-01-15",
      description: "Same description",
      accountName: "Leaf",
      fullPath: "Shared:Leaf",
      pathParts: ["Shared", "Leaf"],
      amount: 10,
    };
    const categoryFields = {
      expenseBreakdown: [expenseCategory(10)],
      monthlyExpensesByCategory: [monthlyCategory(10)],
      monthlyIncomeByCategory: [monthlyCategory(10)],
      monthlyCashInflowByCategory: [monthlyCategory(10)],
      monthlyCashOutflowByCategory: [monthlyCategory(10)],
      expenseTransactions: [transaction],
      incomeTransactions: [transaction],
      expenseCategoryColors: { Shared: "#111111" },
      incomeCategoryColors: { Shared: "#222222" },
      cashInflowCategoryColors: { Shared: "#333333" },
      cashOutflowCategoryColors: { Shared: "#444444" },
    };
    const result = buildConsolidatedData(
      syntheticData(categoryFields),
      syntheticData(categoryFields),
      manifest,
    ).data;

    for (const field of [
      "monthlyExpensesByCategory",
      "monthlyIncomeByCategory",
      "monthlyCashInflowByCategory",
      "monthlyCashOutflowByCategory",
    ] as const) {
      expect(result[field].map((row) => ({ category: row.category, fullPath: row.fullPath, pathParts: row.pathParts }))).toEqual([
        { category: "[Personal] Leaf", fullPath: "personal:Shared:Leaf", pathParts: ["personal:Shared", "Leaf"] },
        { category: "[LLC] Leaf", fullPath: "business:Shared:Leaf", pathParts: ["business:Shared", "Leaf"] },
      ]);
    }
    expect(result.expenseBreakdown.map((row) => ({ name: row.name, fullPath: row.fullPath }))).toEqual([
      { name: "[Personal] Shared", fullPath: "personal:Shared" },
      { name: "[LLC] Shared", fullPath: "business:Shared" },
    ]);
    for (const field of ["expenseTransactions", "incomeTransactions"] as const) {
      expect(result[field].map((row) => ({ accountName: row.accountName, fullPath: row.fullPath, pathParts: row.pathParts }))).toEqual([
        { accountName: "[Personal] Leaf", fullPath: "personal:Shared:Leaf", pathParts: ["personal:Shared", "Leaf"] },
        { accountName: "[LLC] Leaf", fullPath: "business:Shared:Leaf", pathParts: ["business:Shared", "Leaf"] },
      ]);
    }
    expect(result.expenseCategoryColors).toEqual({ "personal:Shared": "#111111", "business:Shared": "#111111" });
    expect(result.incomeCategoryColors).toEqual({ "personal:Shared": "#222222", "business:Shared": "#222222" });
    expect(result.cashInflowCategoryColors).toEqual({ "personal:Shared": "#333333", "business:Shared": "#333333" });
    expect(result.cashOutflowCategoryColors).toEqual({ "personal:Shared": "#444444", "business:Shared": "#444444" });
  });

  it("combines every excluding-closing field with normal-data fallback per book", () => {
    const personal = syntheticData({
      hasClosingTransactions: true,
      cashFlowSeries: [{ month: "2026-01", income: 100, expenses: 50, net: 50 }],
      cashFlowSeriesExcludingClosing: [{ month: "2026-01", income: 10, expenses: 4, net: 6 }],
      expenseBreakdown: [expenseCategory(50)],
      expenseBreakdownExcludingClosing: [expenseCategory(4)],
      monthlyExpensesByCategory: [monthlyCategory(50)],
      monthlyExpensesByCategoryExcludingClosing: [monthlyCategory(4)],
      expenseCategoryColors: { Shared: "normal-expense" },
      expenseCategoryColorsExcludingClosing: { Shared: "personal-expense" },
      monthlyIncomeByCategory: [monthlyCategory(100)],
      monthlyIncomeByCategoryExcludingClosing: [monthlyCategory(10)],
      incomeCategoryColors: { Shared: "normal-income" },
      incomeCategoryColorsExcludingClosing: { Shared: "personal-income" },
      monthlyCashInflowByCategory: [monthlyCategory(100)],
      monthlyCashInflowByCategoryExcludingClosing: [monthlyCategory(10)],
      monthlyCashOutflowByCategory: [monthlyCategory(50)],
      monthlyCashOutflowByCategoryExcludingClosing: [monthlyCategory(4)],
      cashInflowCategoryColors: { Shared: "normal-inflow" },
      cashInflowCategoryColorsExcludingClosing: { Shared: "personal-inflow" },
      cashOutflowCategoryColors: { Shared: "normal-outflow" },
      cashOutflowCategoryColorsExcludingClosing: { Shared: "personal-outflow" },
    });
    const business = syntheticData({
      hasClosingTransactions: false,
      cashFlowSeries: [{ month: "2026-01", income: 20, expenses: 5, net: 15 }],
      expenseBreakdown: [expenseCategory(5)],
      monthlyExpensesByCategory: [monthlyCategory(5)],
      expenseCategoryColors: { Shared: "business-expense" },
      monthlyIncomeByCategory: [monthlyCategory(20)],
      incomeCategoryColors: { Shared: "business-income" },
      monthlyCashInflowByCategory: [monthlyCategory(20)],
      monthlyCashOutflowByCategory: [monthlyCategory(5)],
      cashInflowCategoryColors: { Shared: "business-inflow" },
      cashOutflowCategoryColors: { Shared: "business-outflow" },
    });

    const result = buildConsolidatedData(personal, business, manifest).data;
    expect(result.cashFlowSeriesExcludingClosing).toEqual([
      { month: "2026-01", income: 30, expenses: 9, net: 21 },
    ]);
    expect(result.expenseBreakdownExcludingClosing?.map((row) => row.amount)).toEqual([4, 5]);
    expect(result.monthlyExpensesByCategoryExcludingClosing?.map((row) => row.amount)).toEqual([4, 5]);
    expect(result.monthlyIncomeByCategoryExcludingClosing?.map((row) => row.amount)).toEqual([10, 20]);
    expect(result.monthlyCashInflowByCategoryExcludingClosing?.map((row) => row.amount)).toEqual([10, 20]);
    expect(result.monthlyCashOutflowByCategoryExcludingClosing?.map((row) => row.amount)).toEqual([4, 5]);
    expect(result.expenseCategoryColorsExcludingClosing).toEqual({ "personal:Shared": "personal-expense", "business:Shared": "business-expense" });
    expect(result.incomeCategoryColorsExcludingClosing).toEqual({ "personal:Shared": "personal-income", "business:Shared": "business-income" });
    expect(result.cashInflowCategoryColorsExcludingClosing).toEqual({ "personal:Shared": "personal-inflow", "business:Shared": "business-inflow" });
    expect(result.cashOutflowCategoryColorsExcludingClosing).toEqual({ "personal:Shared": "personal-outflow", "business:Shared": "business-outflow" });
  });

  it("keeps verified income and expense eliminations consistent with category totals", () => {
    const withEliminations = structuredClone(manifest);
    withEliminations.consolidation.eliminations = [
      { id: "income", metric: "income", amount: -10, currency: "USD", status: "verified", rationale: "paired income", effective_month: "2026-01" },
      { id: "expense", metric: "expenses", amount: -5, currency: "USD", status: "verified", rationale: "paired expense", effective_month: "2026-01" },
    ];
    const personal = syntheticData({
      cashFlowSeries: [{ month: "2026-01", income: 100, expenses: 50, net: 50 }],
      expenseBreakdown: [expenseCategory(50)],
      monthlyExpensesByCategory: [monthlyCategory(50)],
      monthlyIncomeByCategory: [monthlyCategory(100)],
      monthlyCashInflowByCategory: [monthlyCategory(100)],
      monthlyCashOutflowByCategory: [monthlyCategory(50)],
    });
    const business = syntheticData({
      cashFlowSeries: [{ month: "2026-01", income: 40, expenses: 20, net: 20 }],
      expenseBreakdown: [expenseCategory(20)],
      monthlyExpensesByCategory: [monthlyCategory(20)],
      monthlyIncomeByCategory: [monthlyCategory(40)],
      monthlyCashInflowByCategory: [monthlyCategory(40)],
      monthlyCashOutflowByCategory: [monthlyCategory(20)],
    });

    const result = buildConsolidatedData(personal, business, withEliminations).data;
    const overview = result.cashFlowSeries.find((row) => row.month === "2026-01");
    expect(overview).toEqual({ month: "2026-01", income: 130, expenses: 65, net: 65 });
    expect(sumMonth(result.monthlyIncomeByCategory, "2026-01")).toBe(overview?.income);
    expect(sumMonth(result.monthlyExpensesByCategory, "2026-01")).toBe(overview?.expenses);
    expect(sumMonth(result.monthlyCashInflowByCategory, "2026-01")).toBe(overview?.income);
    expect(sumMonth(result.monthlyCashOutflowByCategory, "2026-01")).toBe(overview?.expenses);
    expect(result.expenseBreakdown.reduce((sum, row) => sum + row.amount, 0)).toBe(overview?.expenses);
    expect(result.monthlyIncomeByCategory).toContainEqual(expect.objectContaining({ fullPath: "consolidation:income-eliminations", amount: -10 }));
    expect(result.monthlyExpensesByCategory).toContainEqual(expect.objectContaining({ fullPath: "consolidation:expense-eliminations", amount: -5 }));
  });

  it("carries each book and ticker's investment value across union months", () => {
    const personal = syntheticData({
      investmentValueSeries: [
        { month: "2026-01", ticker: "SAME", value: 100, costBasis: 80 },
        { month: "2026-03", ticker: "SAME", value: 130, costBasis: 90 },
      ],
    });
    const business = syntheticData({
      investmentValueSeries: [
        { month: "2026-01", ticker: "SAME", value: 10, costBasis: 8 },
        { month: "2026-02", ticker: "SAME", value: 20, costBasis: 15 },
      ],
    });

    const rows = buildConsolidatedData(personal, business, manifest).data.investmentValueSeries;
    expect(rows).toHaveLength(6);
    expect(["2026-01", "2026-02", "2026-03"].map((month) => ({
      month,
      value: rows.filter((row) => row.month === month).reduce((sum, row) => sum + row.value, 0),
      costBasis: rows.filter((row) => row.month === month).reduce((sum, row) => sum + row.costBasis, 0),
    }))).toEqual([
      { month: "2026-01", value: 110, costBasis: 88 },
      { month: "2026-02", value: 120, costBasis: 95 },
      { month: "2026-03", value: 150, costBasis: 105 },
    ]);
  });
});
