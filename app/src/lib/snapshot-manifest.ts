import type {
  AccountNode,
  DashboardData,
  ExpenseCategory,
  LedgerTransaction,
  MonthlyCashFlow,
  MonthlyExpenseByCategory,
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

function sumMonthlyCashFlow(series: MonthlyCashFlow[][]): MonthlyCashFlow[] {
  const months = new Map<string, MonthlyCashFlow>();
  for (const rows of series) for (const row of rows) {
    const total = months.get(row.month) ?? { month: row.month, income: 0, expenses: 0, net: 0 };
    total.income += row.income; total.expenses += row.expenses; total.net += row.net;
    months.set(row.month, total);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function sumMonthlyNetWorth(series: MonthlyNetWorth[][], eliminations: ConsolidationElimination[]): MonthlyNetWorth[] {
  const months = new Map<string, MonthlyNetWorth>();
  for (const rows of series) for (const row of rows) {
    const total = months.get(row.month) ?? { month: row.month, assets: 0, liabilities: 0, netWorth: 0 };
    total.assets += row.assets; total.liabilities += row.liabilities; total.netWorth += row.netWorth;
    months.set(row.month, total);
  }
  return [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((row) => ({
    ...row,
    netWorth: row.netWorth + eliminations.filter((item) => item.metric === "net_worth" && item.effective_month <= row.month).reduce((sum, item) => sum + item.amount, 0),
  }));
}

function prefixAccounts(rows: AccountNode[], prefix: string): AccountNode[] {
  return rows.map((row) => ({
    ...row,
    guid: `${prefix}:${row.guid}`,
    parentGuid: row.parentGuid ? `${prefix}:${row.parentGuid}` : null,
    name: `[${prefix === "personal" ? "Personal" : "LLC"}] ${row.name}`,
    fullPath: `${prefix}:${row.fullPath}`,
    children: prefixAccounts(row.children, prefix),
  }));
}

function prefixLedger(rows: LedgerTransaction[], prefix: string): LedgerTransaction[] {
  return rows.map((row) => ({
    ...row,
    guid: `${prefix}:${row.guid}`,
    description: `[${prefix === "personal" ? "Personal" : "LLC"}] ${row.description}`,
    splits: row.splits.map((split) => ({ ...split, accountGuid: `${prefix}:${split.accountGuid}`, accountFullPath: `${prefix}:${split.accountFullPath}` })),
  }));
}

function prefixBreakdown(rows: ExpenseCategory[], prefix: string): ExpenseCategory[] {
  return rows.map((row) => ({ ...row, name: `[${prefix}] ${row.name}`, fullPath: `${prefix}:${row.fullPath}`, children: row.children ? prefixBreakdown(row.children, prefix) : undefined }));
}

function joinCategories(rows: MonthlyExpenseByCategory[][]): MonthlyExpenseByCategory[] {
  return rows.flat();
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
  const cashFlowSeries = sumMonthlyCashFlow([personal.cashFlowSeries, business.cashFlowSeries]).map((row) => {
    const monthIncome = verifiedEliminations.filter((item) => item.metric === "income" && item.effective_month === row.month).reduce((sum, item) => sum + item.amount, 0);
    const monthExpenses = verifiedEliminations.filter((item) => item.metric === "expenses" && item.effective_month === row.month).reduce((sum, item) => sum + item.amount, 0);
    return { ...row, income: row.income + monthIncome, expenses: row.expenses + monthExpenses, net: row.net + monthIncome - monthExpenses };
  });
  const currentMonth = new Date().toISOString().slice(0, 7);
  const currentIncomeAdjustment = verifiedEliminations.filter((item) => item.metric === "income" && item.effective_month === currentMonth).reduce((sum, item) => sum + item.amount, 0);
  const currentExpenseAdjustment = verifiedEliminations.filter((item) => item.metric === "expenses" && item.effective_month === currentMonth).reduce((sum, item) => sum + item.amount, 0);
  const data: DashboardData = {
    ...personal,
    accounts: [...prefixAccounts(personal.accounts, "personal"), ...prefixAccounts(business.accounts, "business")],
    netWorthSeries: sumMonthlyNetWorth([personal.netWorthSeries, business.netWorthSeries], verifiedEliminations),
    cashFlowSeries,
    expenseBreakdown: [...prefixBreakdown(personal.expenseBreakdown, "Personal"), ...prefixBreakdown(business.expenseBreakdown, "LLC")],
    monthlyExpensesByCategory: joinCategories([personal.monthlyExpensesByCategory, business.monthlyExpensesByCategory]),
    expenseTransactions: [...personal.expenseTransactions, ...business.expenseTransactions],
    monthlyIncomeByCategory: joinCategories([personal.monthlyIncomeByCategory, business.monthlyIncomeByCategory]),
    incomeTransactions: [...personal.incomeTransactions, ...business.incomeTransactions],
    investments: [...personal.investments.map((x) => ({ ...x, accountName: `[Personal] ${x.accountName}` })), ...business.investments.map((x) => ({ ...x, accountName: `[LLC] ${x.accountName}` }))],
    investmentValueSeries: [...personal.investmentValueSeries, ...business.investmentValueSeries],
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
    hasClosingTransactions: personal.hasClosingTransactions || business.hasClosingTransactions,
    monthlyCashInflowByCategory: joinCategories([personal.monthlyCashInflowByCategory, business.monthlyCashInflowByCategory]),
    monthlyCashOutflowByCategory: joinCategories([personal.monthlyCashOutflowByCategory, business.monthlyCashOutflowByCategory]),
    cashInflowCategoryColors: { ...personal.cashInflowCategoryColors, ...business.cashInflowCategoryColors },
    cashOutflowCategoryColors: { ...personal.cashOutflowCategoryColors, ...business.cashOutflowCategoryColors },
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
