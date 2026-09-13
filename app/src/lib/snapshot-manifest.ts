import type {
  AccountNode,
  DashboardData,
  ExpenseCategory,
  ExpenseTransaction,
  LedgerTransaction,
  MonthlyCashFlow,
  MonthlyExpenseByCategory,
  MonthlyInvestmentValue,
  MonthlyNetWorth,
} from "@/lib/types/gnucash";

export type BookScope = "personal" | "business" | "all";
export type EliminationMetric = "net_worth" | "income" | "expenses";

export interface SnapshotBook {
  id: "personal" | "business";
  label: string;
  scope: "personal" | "business";
  url: string;
  generated_at: string;
  sha256: string;
  size_bytes: number;
  integrity: "ok";
  source_engine: "sqlite-online-backup";
}

export interface ConsolidationElimination {
  id: string;
  metric: EliminationMetric;
  amount: number;
  currency: string;
  status: "verified" | "pending" | "unknown";
  rationale: string;
  effective_month: string;
  personal_transaction_guid?: string;
  business_transaction_guid?: string;
}

export interface SnapshotManifest {
  schema_version: 1;
  generated_at: string;
  refresh_seconds: number;
  books: SnapshotBook[];
  consolidation: {
    policy: "explicit-only";
    eliminations: ConsolidationElimination[];
    qualification_notes: string[];
  };
  operational: {
    failed_imports: number | null;
    stale_feeds: number | null;
    snapshot_failures: number;
    manual_valuation_warn_days: number;
  };
}

export interface ConsolidationBridge {
  publication: "verified" | "qualified";
  personalNetWorth: number;
  businessNetWorth: number;
  verifiedNetWorthEliminations: number;
  consolidatedNetWorth: number;
  verifiedEliminations: ConsolidationElimination[];
  unresolvedEliminations: ConsolidationElimination[];
  qualificationNotes: string[];
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireIsoDate(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${label} must be an ISO date`);
  return text;
}

export function parseSnapshotManifest(value: unknown): SnapshotManifest {
  const root = requireObject(value, "manifest");
  if (root.schema_version !== 1) throw new Error("Unsupported snapshot manifest schema_version");
  requireIsoDate(root.generated_at, "generated_at");
  if (!Number.isInteger(root.refresh_seconds) || Number(root.refresh_seconds) < 15) {
    throw new Error("refresh_seconds must be an integer >= 15");
  }
  if (!Array.isArray(root.books) || root.books.length !== 2) {
    throw new Error("manifest must contain exactly personal and business snapshots");
  }
  const ids = new Set<string>();
  for (const rawBook of root.books) {
    const book = requireObject(rawBook, "book");
    const id = requireString(book.id, "book.id");
    if (id !== "personal" && id !== "business") throw new Error("book.id must be personal or business");
    if (ids.has(id)) throw new Error(`duplicate book.id: ${id}`);
    ids.add(id);
    if (book.scope !== id) throw new Error(`book.scope must match ${id}`);
    const url = requireString(book.url, "book.url");
    if (!url.startsWith("/snapshots/") || url.includes("..")) throw new Error("book.url must be a safe /snapshots/ URL");
    requireString(book.label, "book.label");
    requireIsoDate(book.generated_at, "book.generated_at");
    if (!/^[a-f0-9]{64}$/.test(requireString(book.sha256, "book.sha256"))) throw new Error("book.sha256 must be lowercase SHA-256");
    if (!Number.isInteger(book.size_bytes) || Number(book.size_bytes) <= 0) throw new Error("book.size_bytes must be positive");
    if (book.integrity !== "ok" || book.source_engine !== "sqlite-online-backup") throw new Error("snapshot must be a validated SQLite online backup");
  }
  if (!ids.has("personal") || !ids.has("business")) throw new Error("both personal and business snapshots are required");

  const consolidation = requireObject(root.consolidation, "consolidation");
  if (consolidation.policy !== "explicit-only") throw new Error("consolidation.policy must be explicit-only");
  if (!Array.isArray(consolidation.eliminations) || !Array.isArray(consolidation.qualification_notes)) {
    throw new Error("consolidation lists are required");
  }
  for (const raw of consolidation.eliminations) {
    const item = requireObject(raw, "elimination");
    requireString(item.id, "elimination.id");
    if (!(["net_worth", "income", "expenses"] as unknown[]).includes(item.metric)) throw new Error("invalid elimination.metric");
    if (typeof item.amount !== "number" || !Number.isFinite(item.amount)) throw new Error("elimination.amount must be finite");
    requireString(item.currency, "elimination.currency");
    if (!(["verified", "pending", "unknown"] as unknown[]).includes(item.status)) throw new Error("invalid elimination.status");
    requireString(item.rationale, "elimination.rationale");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(requireString(item.effective_month, "elimination.effective_month"))) throw new Error("invalid elimination.effective_month");
  }

  const operational = requireObject(root.operational, "operational");
  for (const key of ["snapshot_failures", "manual_valuation_warn_days"] as const) {
    if (!Number.isInteger(operational[key]) || Number(operational[key]) < 0) throw new Error(`operational.${key} must be a non-negative integer`);
  }
  for (const key of ["failed_imports", "stale_feeds"] as const) {
    if (operational[key] !== null && (!Number.isInteger(operational[key]) || Number(operational[key]) < 0)) {
      throw new Error(`operational.${key} must be null or a non-negative integer`);
    }
  }
  return value as SnapshotManifest;
}

export async function verifySnapshotBytes(book: SnapshotBook, bytes: ArrayBuffer): Promise<void> {
  if (bytes.byteLength !== book.size_bytes) throw new Error(`${book.id} snapshot size does not match manifest`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  if (actual !== book.sha256) throw new Error(`${book.id} snapshot digest does not match manifest`);
  if (new TextDecoder().decode(bytes.slice(0, 16)) !== "SQLite format 3\u0000") {
    throw new Error(`${book.id} snapshot is not SQLite`);
  }
}

function sumMonthlyCashFlow(
  series: MonthlyCashFlow[][],
  eliminations: ConsolidationElimination[],
): MonthlyCashFlow[] {
  const months = new Map<string, MonthlyCashFlow>();
  for (const rows of series) for (const row of rows) {
    const total = months.get(row.month) ?? { month: row.month, income: 0, expenses: 0, net: 0 };
    total.income += row.income; total.expenses += row.expenses; total.net += row.net;
    months.set(row.month, total);
  }
  for (const item of eliminations) {
    if (item.metric !== "income" && item.metric !== "expenses") continue;
    const total = months.get(item.effective_month) ?? { month: item.effective_month, income: 0, expenses: 0, net: 0 };
    if (item.metric === "income") {
      total.income += item.amount;
      total.net += item.amount;
    } else {
      total.expenses += item.amount;
      total.net -= item.amount;
    }
    months.set(item.effective_month, total);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function sumMonthlyNetWorth(series: MonthlyNetWorth[][], eliminations: ConsolidationElimination[]): MonthlyNetWorth[] {
  const months = [...new Set(series.flatMap((rows) => rows.map((row) => row.month)))].sort();
  const rowsBySeries = series.map((rows) => new Map(rows.map((row) => [row.month, row])));
  const lastKnown: Array<MonthlyNetWorth | undefined> = rowsBySeries.map(() => undefined);
  return months.map((month) => {
    const total: MonthlyNetWorth = { month, assets: 0, liabilities: 0, netWorth: 0 };
    rowsBySeries.forEach((rows, index) => {
      lastKnown[index] = rows.get(month) ?? lastKnown[index];
      const row = lastKnown[index];
      if (!row) return;
      total.assets += row.assets;
      total.liabilities += row.liabilities;
      total.netWorth += row.netWorth;
    });
    total.netWorth += eliminations
      .filter((item) => item.metric === "net_worth" && item.effective_month <= month)
      .reduce((sum, item) => sum + item.amount, 0);
    return total;
  });
}

type ConsolidatedBookId = SnapshotBook["id"];

function bookLabel(book: ConsolidatedBookId): string {
  return book === "personal" ? "Personal" : "LLC";
}

function prefixPathParts(pathParts: string[], book: ConsolidatedBookId): string[] {
  if (pathParts.length === 0) return [book];
  return [`${book}:${pathParts[0]}`, ...pathParts.slice(1)];
}

function prefixAccounts(rows: AccountNode[], prefix: ConsolidatedBookId): AccountNode[] {
  return rows.map((row) => ({
    ...row,
    guid: `${prefix}:${row.guid}`,
    parentGuid: row.parentGuid ? `${prefix}:${row.parentGuid}` : null,
    name: `[${prefix === "personal" ? "Personal" : "LLC"}] ${row.name}`,
    fullPath: `${prefix}:${row.fullPath}`,
    children: prefixAccounts(row.children, prefix),
  }));
}

function prefixLedger(rows: LedgerTransaction[], prefix: ConsolidatedBookId): LedgerTransaction[] {
  return rows.map((row) => ({
    ...row,
    guid: `${prefix}:${row.guid}`,
    description: `[${prefix === "personal" ? "Personal" : "LLC"}] ${row.description}`,
    splits: row.splits.map((split) => ({
      ...split,
      accountGuid: `${prefix}:${split.accountGuid}`,
      accountName: `[${bookLabel(prefix)}] ${split.accountName}`,
      accountFullPath: `${prefix}:${split.accountFullPath}`,
    })),
  }));
}

function prefixBreakdown(rows: ExpenseCategory[], book: ConsolidatedBookId): ExpenseCategory[] {
  return rows.map((row) => ({
    ...row,
    name: `[${bookLabel(book)}] ${row.name}`,
    fullPath: `${book}:${row.fullPath}`,
    children: row.children ? prefixBreakdown(row.children, book) : undefined,
  }));
}

function prefixCategories(rows: MonthlyExpenseByCategory[], book: ConsolidatedBookId): MonthlyExpenseByCategory[] {
  return rows.map((row) => ({
    ...row,
    category: `[${bookLabel(book)}] ${row.category}`,
    fullPath: `${book}:${row.fullPath}`,
    pathParts: prefixPathParts(row.pathParts, book),
  }));
}

function prefixExpenseTransactions(rows: ExpenseTransaction[], book: ConsolidatedBookId): ExpenseTransaction[] {
  return rows.map((row) => ({
    ...row,
    accountName: `[${bookLabel(book)}] ${row.accountName}`,
    fullPath: `${book}:${row.fullPath}`,
    pathParts: prefixPathParts(row.pathParts, book),
  }));
}

function prefixCategoryColors(colors: Record<string, string>, book: ConsolidatedBookId): Record<string, string> {
  return Object.fromEntries(Object.entries(colors).map(([key, color]) => [`${book}:${key}`, color]));
}

function eliminationCategoryRows(
  eliminations: ConsolidationElimination[],
  metric: "income" | "expenses",
): MonthlyExpenseByCategory[] {
  const amounts = new Map<string, number>();
  for (const item of eliminations) {
    if (item.metric === metric) amounts.set(item.effective_month, (amounts.get(item.effective_month) ?? 0) + item.amount);
  }
  const slug = metric === "income" ? "income-eliminations" : "expense-eliminations";
  const label = metric === "income" ? "Income eliminations" : "Expense eliminations";
  return [...amounts.entries()]
    .filter(([, amount]) => amount !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amount]) => ({
      month,
      category: `[Consolidation] ${label}`,
      fullPath: `consolidation:${slug}`,
      pathParts: ["consolidation", slug],
      amount,
    }));
}

function appendEliminationRows(
  rows: MonthlyExpenseByCategory[],
  eliminations: ConsolidationElimination[],
  metric: "income" | "expenses",
): MonthlyExpenseByCategory[] {
  return [...rows, ...eliminationCategoryRows(eliminations, metric)];
}

function appendExpenseEliminationBreakdown(
  rows: ExpenseCategory[],
  eliminations: ConsolidationElimination[],
): ExpenseCategory[] {
  const amount = eliminations
    .filter((item) => item.metric === "expenses")
    .reduce((sum, item) => sum + item.amount, 0);
  if (amount === 0) return rows;
  return [...rows, {
    name: "[Consolidation] Expense eliminations",
    fullPath: "consolidation:expense-eliminations",
    amount,
    color: "#7C6F9B",
  }];
}

function appendEliminationColor(
  colors: Record<string, string>,
  eliminations: ConsolidationElimination[],
  metric: "income" | "expenses",
): Record<string, string> {
  return eliminations.some((item) => item.metric === metric && item.amount !== 0)
    ? { ...colors, consolidation: "#7C6F9B" }
    : colors;
}

function carryInvestmentValues(series: MonthlyInvestmentValue[][]): MonthlyInvestmentValue[] {
  const months = [...new Set(series.flatMap((rows) => rows.map((row) => row.month)))].sort();
  const result: MonthlyInvestmentValue[] = [];
  for (const rows of series) {
    const byTicker = new Map<string, Map<string, { value: number; costBasis: number; valuationOnly: boolean }>>();
    for (const row of rows) {
      let byMonth = byTicker.get(row.ticker);
      if (!byMonth) {
        byMonth = new Map();
        byTicker.set(row.ticker, byMonth);
      }
      const current = byMonth.get(row.month);
      if (current) {
        current.value += row.value;
        current.costBasis += row.costBasis;
        current.valuationOnly = current.valuationOnly && row.valuationOnly === true;
      } else {
        byMonth.set(row.month, {
          value: row.value,
          costBasis: row.costBasis,
          valuationOnly: row.valuationOnly === true,
        });
      }
    }
    for (const [ticker, byMonth] of byTicker) {
      let lastKnown: { value: number; costBasis: number; valuationOnly: boolean } | undefined;
      for (const month of months) {
        lastKnown = byMonth.get(month) ?? lastKnown;
        if (!lastKnown) continue;
        result.push({
          month,
          ticker,
          value: lastKnown.value,
          costBasis: lastKnown.costBasis,
          ...(lastKnown.valuationOnly ? { valuationOnly: true } : {}),
        });
      }
    }
  }
  return result;
}

export function buildConsolidatedData(
  personal: DashboardData,
  business: DashboardData,
  manifest: SnapshotManifest,
): { data: DashboardData; bridge: ConsolidationBridge } {
  if (personal.currency !== business.currency) throw new Error("Consolidation requires matching base currencies");
  const verifiedEliminations = manifest.consolidation.eliminations.filter((item) => item.status === "verified" && item.currency === personal.currency && /^\d{4}-(0[1-9]|1[0-2])$/.test(item.effective_month));
  const unresolvedEliminations = manifest.consolidation.eliminations.filter((item) => item.status !== "verified" || item.currency !== personal.currency);
  const adjustment = (metric: EliminationMetric) => verifiedEliminations.filter((item) => item.metric === metric).reduce((sum, item) => sum + item.amount, 0);
  const netWorthAdjustment = adjustment("net_worth");
  const qualificationNotes = [...manifest.consolidation.qualification_notes];
  if (manifest.consolidation.eliminations.length === 0) qualificationNotes.push("No cross-book elimination evidence was supplied; no owner entries were eliminated.");
  if (unresolvedEliminations.length) qualificationNotes.push("Pending, unknown, or currency-mismatched eliminations were not applied.");
  const publication: ConsolidationBridge["publication"] = qualificationNotes.length || unresolvedEliminations.length ? "qualified" : "verified";
  const cashFlowSeries = sumMonthlyCashFlow(
    [personal.cashFlowSeries, business.cashFlowSeries],
    verifiedEliminations,
  );
  const expenseBreakdown = appendExpenseEliminationBreakdown([
    ...prefixBreakdown(personal.expenseBreakdown, "personal"),
    ...prefixBreakdown(business.expenseBreakdown, "business"),
  ], verifiedEliminations);
  const monthlyExpensesByCategory = appendEliminationRows([
    ...prefixCategories(personal.monthlyExpensesByCategory, "personal"),
    ...prefixCategories(business.monthlyExpensesByCategory, "business"),
  ], verifiedEliminations, "expenses");
  const monthlyIncomeByCategory = appendEliminationRows([
    ...prefixCategories(personal.monthlyIncomeByCategory, "personal"),
    ...prefixCategories(business.monthlyIncomeByCategory, "business"),
  ], verifiedEliminations, "income");
  const monthlyCashInflowByCategory = appendEliminationRows([
    ...prefixCategories(personal.monthlyCashInflowByCategory, "personal"),
    ...prefixCategories(business.monthlyCashInflowByCategory, "business"),
  ], verifiedEliminations, "income");
  const monthlyCashOutflowByCategory = appendEliminationRows([
    ...prefixCategories(personal.monthlyCashOutflowByCategory, "personal"),
    ...prefixCategories(business.monthlyCashOutflowByCategory, "business"),
  ], verifiedEliminations, "expenses");
  const expenseCategoryColors = appendEliminationColor({
    ...prefixCategoryColors(personal.expenseCategoryColors, "personal"),
    ...prefixCategoryColors(business.expenseCategoryColors, "business"),
  }, verifiedEliminations, "expenses");
  const incomeCategoryColors = appendEliminationColor({
    ...prefixCategoryColors(personal.incomeCategoryColors, "personal"),
    ...prefixCategoryColors(business.incomeCategoryColors, "business"),
  }, verifiedEliminations, "income");
  const cashInflowCategoryColors = appendEliminationColor({
    ...prefixCategoryColors(personal.cashInflowCategoryColors, "personal"),
    ...prefixCategoryColors(business.cashInflowCategoryColors, "business"),
  }, verifiedEliminations, "income");
  const cashOutflowCategoryColors = appendEliminationColor({
    ...prefixCategoryColors(personal.cashOutflowCategoryColors, "personal"),
    ...prefixCategoryColors(business.cashOutflowCategoryColors, "business"),
  }, verifiedEliminations, "expenses");

  const hasClosingTransactions = personal.hasClosingTransactions || business.hasClosingTransactions;
  const cashFlowSeriesExcludingClosing = hasClosingTransactions
    ? sumMonthlyCashFlow([
      personal.cashFlowSeriesExcludingClosing ?? personal.cashFlowSeries,
      business.cashFlowSeriesExcludingClosing ?? business.cashFlowSeries,
    ], verifiedEliminations)
    : undefined;
  const expenseBreakdownExcludingClosing = hasClosingTransactions
    ? appendExpenseEliminationBreakdown([
      ...prefixBreakdown(personal.expenseBreakdownExcludingClosing ?? personal.expenseBreakdown, "personal"),
      ...prefixBreakdown(business.expenseBreakdownExcludingClosing ?? business.expenseBreakdown, "business"),
    ], verifiedEliminations)
    : undefined;
  const monthlyExpensesByCategoryExcludingClosing = hasClosingTransactions
    ? appendEliminationRows([
      ...prefixCategories(personal.monthlyExpensesByCategoryExcludingClosing ?? personal.monthlyExpensesByCategory, "personal"),
      ...prefixCategories(business.monthlyExpensesByCategoryExcludingClosing ?? business.monthlyExpensesByCategory, "business"),
    ], verifiedEliminations, "expenses")
    : undefined;
  const expenseCategoryColorsExcludingClosing = hasClosingTransactions
    ? appendEliminationColor({
      ...prefixCategoryColors(personal.expenseCategoryColorsExcludingClosing ?? personal.expenseCategoryColors, "personal"),
      ...prefixCategoryColors(business.expenseCategoryColorsExcludingClosing ?? business.expenseCategoryColors, "business"),
    }, verifiedEliminations, "expenses")
    : undefined;
  const monthlyIncomeByCategoryExcludingClosing = hasClosingTransactions
    ? appendEliminationRows([
      ...prefixCategories(personal.monthlyIncomeByCategoryExcludingClosing ?? personal.monthlyIncomeByCategory, "personal"),
      ...prefixCategories(business.monthlyIncomeByCategoryExcludingClosing ?? business.monthlyIncomeByCategory, "business"),
    ], verifiedEliminations, "income")
    : undefined;
  const incomeCategoryColorsExcludingClosing = hasClosingTransactions
    ? appendEliminationColor({
      ...prefixCategoryColors(personal.incomeCategoryColorsExcludingClosing ?? personal.incomeCategoryColors, "personal"),
      ...prefixCategoryColors(business.incomeCategoryColorsExcludingClosing ?? business.incomeCategoryColors, "business"),
    }, verifiedEliminations, "income")
    : undefined;
  const monthlyCashInflowByCategoryExcludingClosing = hasClosingTransactions
    ? appendEliminationRows([
      ...prefixCategories(personal.monthlyCashInflowByCategoryExcludingClosing ?? personal.monthlyCashInflowByCategory, "personal"),
      ...prefixCategories(business.monthlyCashInflowByCategoryExcludingClosing ?? business.monthlyCashInflowByCategory, "business"),
    ], verifiedEliminations, "income")
    : undefined;
  const monthlyCashOutflowByCategoryExcludingClosing = hasClosingTransactions
    ? appendEliminationRows([
      ...prefixCategories(personal.monthlyCashOutflowByCategoryExcludingClosing ?? personal.monthlyCashOutflowByCategory, "personal"),
      ...prefixCategories(business.monthlyCashOutflowByCategoryExcludingClosing ?? business.monthlyCashOutflowByCategory, "business"),
    ], verifiedEliminations, "expenses")
    : undefined;
  const cashInflowCategoryColorsExcludingClosing = hasClosingTransactions
    ? appendEliminationColor({
      ...prefixCategoryColors(personal.cashInflowCategoryColorsExcludingClosing ?? personal.cashInflowCategoryColors, "personal"),
      ...prefixCategoryColors(business.cashInflowCategoryColorsExcludingClosing ?? business.cashInflowCategoryColors, "business"),
    }, verifiedEliminations, "income")
    : undefined;
  const cashOutflowCategoryColorsExcludingClosing = hasClosingTransactions
    ? appendEliminationColor({
      ...prefixCategoryColors(personal.cashOutflowCategoryColorsExcludingClosing ?? personal.cashOutflowCategoryColors, "personal"),
      ...prefixCategoryColors(business.cashOutflowCategoryColorsExcludingClosing ?? business.cashOutflowCategoryColors, "business"),
    }, verifiedEliminations, "expenses")
    : undefined;

  const currentMonth = new Date().toISOString().slice(0, 7);
  const currentIncomeAdjustment = verifiedEliminations.filter((item) => item.metric === "income" && item.effective_month === currentMonth).reduce((sum, item) => sum + item.amount, 0);
  const currentExpenseAdjustment = verifiedEliminations.filter((item) => item.metric === "expenses" && item.effective_month === currentMonth).reduce((sum, item) => sum + item.amount, 0);
  const data: DashboardData = {
    ...personal,
    accounts: [...prefixAccounts(personal.accounts, "personal"), ...prefixAccounts(business.accounts, "business")],
    netWorthSeries: sumMonthlyNetWorth([personal.netWorthSeries, business.netWorthSeries], verifiedEliminations),
    cashFlowSeries,
    expenseBreakdown,
    monthlyExpensesByCategory,
    expenseCategoryColors,
    expenseTransactions: [...prefixExpenseTransactions(personal.expenseTransactions, "personal"), ...prefixExpenseTransactions(business.expenseTransactions, "business")],
    monthlyIncomeByCategory,
    incomeCategoryColors,
    incomeTransactions: [...prefixExpenseTransactions(personal.incomeTransactions, "personal"), ...prefixExpenseTransactions(business.incomeTransactions, "business")],
    investments: [...personal.investments.map((x) => ({ ...x, accountName: `[Personal] ${x.accountName}` })), ...business.investments.map((x) => ({ ...x, accountName: `[LLC] ${x.accountName}` }))],
    investmentValueSeries: carryInvestmentValues([personal.investmentValueSeries, business.investmentValueSeries]),
    topBalances: [...personal.topBalances.map((x) => ({ ...x, accountName: `[Personal] ${x.accountName}`, fullPath: `personal:${x.fullPath}` })), ...business.topBalances.map((x) => ({ ...x, accountName: `[LLC] ${x.accountName}`, fullPath: `business:${x.fullPath}` }))],
    recentTransactions: [...personal.recentTransactions.map((x) => ({ ...x, accountName: `[Personal] ${x.accountName}` })), ...business.recentTransactions.map((x) => ({ ...x, accountName: `[LLC] ${x.accountName}` }))].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 50),
    upcomingBills: [...personal.upcomingBills, ...business.upcomingBills],
    currentNetWorth: personal.currentNetWorth + business.currentNetWorth + netWorthAdjustment,
    currentMonthIncome: personal.currentMonthIncome + business.currentMonthIncome + currentIncomeAdjustment,
    currentMonthExpenses: personal.currentMonthExpenses + business.currentMonthExpenses + currentExpenseAdjustment,
    savingsRate: 0,
    budgetData: null,
    cashFlowBudgetData: null,
    ledgerTransactions: [...prefixLedger(personal.ledgerTransactions, "personal"), ...prefixLedger(business.ledgerTransactions, "business")].sort((a, b) => b.date.localeCompare(a.date)),
    commodities: [...personal.commodities, ...business.commodities.filter((candidate) => !personal.commodities.some((existing) => existing.namespace === candidate.namespace && existing.mnemonic === candidate.mnemonic))],
    prices: [...personal.prices, ...business.prices.map((price) => ({ ...price, guid: `business:${price.guid}` }))],
    orphanedPriceGuids: [...personal.orphanedPriceGuids, ...business.orphanedPriceGuids.map((guid) => `business:${guid}`)],
    hasClosingTransactions,
    cashFlowSeriesExcludingClosing,
    expenseBreakdownExcludingClosing,
    monthlyExpensesByCategoryExcludingClosing,
    expenseCategoryColorsExcludingClosing,
    monthlyIncomeByCategoryExcludingClosing,
    incomeCategoryColorsExcludingClosing,
    monthlyCashInflowByCategory,
    monthlyCashOutflowByCategory,
    cashInflowCategoryColors,
    cashOutflowCategoryColors,
    monthlyCashInflowByCategoryExcludingClosing,
    monthlyCashOutflowByCategoryExcludingClosing,
    cashInflowCategoryColorsExcludingClosing,
    cashOutflowCategoryColorsExcludingClosing,
  };
  data.savingsRate = data.currentMonthIncome === 0 ? 0 : ((data.currentMonthIncome - data.currentMonthExpenses) / data.currentMonthIncome) * 100;
  return {
    data,
    bridge: {
      publication,
      personalNetWorth: personal.currentNetWorth,
      businessNetWorth: business.currentNetWorth,
      verifiedNetWorthEliminations: netWorthAdjustment,
      consolidatedNetWorth: data.currentNetWorth,
      verifiedEliminations,
      unresolvedEliminations,
      qualificationNotes,
    },
  };
}
