import type { InvestmentHolding, MonthlyInvestmentValue } from "@/lib/types/gnucash";
import type { ParseContext } from "../context";
import { buildFullPath } from "../shared/accounts";
import { parseGnuCashDate, sqlMonth } from "../shared/dates";

function getBalanceValuedInvestmentGuids(ctx: ParseContext): Set<string> {
  return new Set(
    ctx.accounts
      .filter((account) => {
        if (account.account_type !== "ASSET" || account.placeholder !== 0) return false;
        const path = buildFullPath(account, ctx.accountMap);
        return path
          .split(":")
          .some((part) => part.trim().toLowerCase() === "investments");
      })
      .map((account) => account.guid)
  );
}

/**
 * Compute current investment holdings for priced STOCK/MUTUAL accounts and
 * balance-valued ASSET accounts kept below an "Investments" account.
 * Calculates cost basis (sum of buy-side split values), market value
 * (shares × latest price), gain/loss, and 12-month performance.
 * All monetary values are converted to base currency.
 */
export function computeInvestments(ctx: ParseContext): InvestmentHolding[] {
  const { db, commodityMap, prices, latestPrices, fxRates } = ctx;

  // Price 12 months ago per commodity
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
  const price12mMap = new Map<string, number>();
  for (const p of prices) {
    const pDate = parseGnuCashDate(p.date);
    if (pDate <= twelveMonthsAgo && !price12mMap.has(p.commodity_guid)) {
      // Normalize to base currency
      const rawPrice = p.value_num / p.value_denom;
      price12mMap.set(p.commodity_guid, fxRates.toBase(p.currency_guid, rawPrice));
    }
  }

  const holdings = db
    .prepare(
      `SELECT
        a.guid AS account_guid,
        a.name AS account_name,
        a.commodity_guid,
        MAX(t.currency_guid) AS tx_currency_guid,
        SUM(CAST(s.quantity_num AS REAL) / s.quantity_denom) AS shares_held,
        SUM(CAST(s.value_num AS REAL) / s.value_denom) AS cost_basis
      FROM splits s
      JOIN accounts a ON s.account_guid = a.guid
      JOIN transactions t ON s.tx_guid = t.guid
      WHERE a.account_type IN ('STOCK', 'MUTUAL')
      GROUP BY a.guid`
    )
    .all() as {
    account_guid: string;
    account_name: string;
    commodity_guid: string;
    tx_currency_guid: string;
    shares_held: number;
    cost_basis: number;
  }[];

  const pricedHoldings = holdings.map((h) => {
    const commodity = commodityMap.get(h.commodity_guid);
    const latestPrice = latestPrices.get(h.commodity_guid) ?? 0;
    const price12m = price12mMap.get(h.commodity_guid);
    const marketValue = h.shares_held * latestPrice;
    // Convert cost basis from transaction currency to base
    const costBasis = fxRates.toBase(h.tx_currency_guid, h.cost_basis);
    const gainLoss = marketValue - costBasis;
    const gainLossPct = costBasis !== 0 ? (gainLoss / Math.abs(costBasis)) * 100 : 0;

    let change12mPct: number | null = null;
    if (price12m && price12m > 0) {
      change12mPct = ((latestPrice - price12m) / price12m) * 100;
    }

    return {
      accountName: h.account_name,
      ticker: commodity?.mnemonic ?? "???",
      sharesHeld: h.shares_held,
      costBasis,
      marketValue,
      gainLoss,
      gainLossPct,
      change12m: change12mPct !== null ? latestPrice - (price12m ?? 0) : null,
      change12mPct,
    };
  });

  // Some books track externally managed retirement, brokerage, crypto, and
  // private-investment accounts as currency-valued ASSET balances rather than
  // individual securities. Include those accounts without inventing shares,
  // prices, cost basis, or returns.
  const valuationAccountGuids = getBalanceValuedInvestmentGuids(ctx);
  const valuationRows = db
    .prepare(
      `SELECT
        a.guid AS account_guid,
        a.name AS account_name,
        a.commodity_guid,
        SUM(CAST(s.quantity_num AS REAL) / s.quantity_denom) AS balance
      FROM accounts a
      LEFT JOIN splits s ON s.account_guid = a.guid
      WHERE a.account_type = 'ASSET' AND a.placeholder = 0
      GROUP BY a.guid`
    )
    .all() as {
    account_guid: string;
    account_name: string;
    commodity_guid: string;
    balance: number | null;
  }[];

  const balanceValuedHoldings: InvestmentHolding[] = valuationRows
    .filter((row) => valuationAccountGuids.has(row.account_guid))
    .map((row) => {
      const marketValue = fxRates.toBase(row.commodity_guid, row.balance ?? 0);
      return {
        accountName: row.account_name,
        ticker: row.account_name,
        sharesHeld: 0,
        costBasis: 0,
        marketValue,
        gainLoss: 0,
        gainLossPct: 0,
        change12m: null,
        change12mPct: null,
        valuationOnly: true,
      };
    });

  return [...pricedHoldings, ...balanceValuedHoldings];
}

/**
 * Compute monthly portfolio value time series for each investment ticker.
 * For each month, calculates cumulative shares held and multiplies by the
 * best available price at that month (carrying forward the last known price).
 * Prices and cost basis are converted to base currency.
 */
export function computeInvestmentValueSeries(ctx: ParseContext): MonthlyInvestmentValue[] {
  const { db, commodityMap, fxRates } = ctx;

  const splits = db
    .prepare(
      `SELECT
        a.guid AS account_guid,
        a.name AS account_name,
        a.commodity_guid,
        t.currency_guid AS tx_currency_guid,
        ${sqlMonth("t.post_date")} AS month,
        CAST(s.quantity_num AS REAL) / s.quantity_denom AS shares,
        CAST(s.value_num AS REAL) / s.value_denom AS cost
      FROM splits s
      JOIN accounts a ON s.account_guid = a.guid
      JOIN transactions t ON s.tx_guid = t.guid
      WHERE a.account_type IN ('STOCK', 'MUTUAL')
      ORDER BY t.post_date`
    )
    .all() as { account_guid: string; account_name: string; commodity_guid: string; tx_currency_guid: string; month: string; shares: number; cost: number }[];

  const accountMonthly = new Map<string, Map<string, { shares: number; cost: number; commodity_guid: string; tx_currency_guid: string }>>();
  for (const s of splits) {
    if (!accountMonthly.has(s.account_guid)) accountMonthly.set(s.account_guid, new Map());
    const months = accountMonthly.get(s.account_guid)!;
    const existing = months.get(s.month);
    if (existing) {
      existing.shares += s.shares;
      existing.cost += s.cost;
    } else {
      months.set(s.month, { shares: s.shares, cost: s.cost, commodity_guid: s.commodity_guid, tx_currency_guid: s.tx_currency_guid });
    }
  }

  const valuationAccountGuids = getBalanceValuedInvestmentGuids(ctx);
  const valuationSplits = db
    .prepare(
      `SELECT
        a.guid AS account_guid,
        a.name AS account_name,
        a.commodity_guid,
        ${sqlMonth("t.post_date")} AS month,
        SUM(CAST(s.quantity_num AS REAL) / s.quantity_denom) AS balance_change
      FROM splits s
      JOIN accounts a ON s.account_guid = a.guid
      JOIN transactions t ON s.tx_guid = t.guid
      WHERE a.account_type = 'ASSET' AND a.placeholder = 0
      GROUP BY a.guid, ${sqlMonth("t.post_date")}
      ORDER BY t.post_date`
    )
    .all() as {
    account_guid: string;
    account_name: string;
    commodity_guid: string;
    month: string;
    balance_change: number;
  }[];

  const valuationMonthly = new Map<
    string,
    {
      accountName: string;
      commodityGuid: string;
      months: Map<string, number>;
    }
  >();
  for (const split of valuationSplits) {
    if (!valuationAccountGuids.has(split.account_guid)) continue;
    let account = valuationMonthly.get(split.account_guid);
    if (!account) {
      account = {
        accountName: split.account_name,
        commodityGuid: split.commodity_guid,
        months: new Map<string, number>(),
      };
      valuationMonthly.set(split.account_guid, account);
    }
    account.months.set(
      split.month,
      (account.months.get(split.month) ?? 0) + split.balance_change
    );
  }

  const allPrices = db
    .prepare(
      `SELECT commodity_guid, currency_guid, ${sqlMonth("date")} AS month, CAST(value_num AS REAL) / value_denom AS price
      FROM prices ORDER BY date`
    )
    .all() as { commodity_guid: string; currency_guid: string; month: string; price: number }[];

  const priceByMonth = new Map<string, Map<string, { price: number; currencyGuid: string }>>();
  for (const p of allPrices) {
    if (!priceByMonth.has(p.commodity_guid)) priceByMonth.set(p.commodity_guid, new Map());
    priceByMonth.get(p.commodity_guid)!.set(p.month, { price: p.price, currencyGuid: p.currency_guid });
  }

  const allMonths = new Set<string>();
  for (const months of accountMonthly.values()) for (const m of months.keys()) allMonths.add(m);
  for (const account of valuationMonthly.values()) for (const m of account.months.keys()) allMonths.add(m);
  for (const months of priceByMonth.values()) for (const m of months.keys()) allMonths.add(m);
  const sortedMonths = [...allMonths].sort();

  const result: MonthlyInvestmentValue[] = [];

  for (const monthlyData of accountMonthly.values()) {
    const firstEntry = [...monthlyData.values()][0];
    if (!firstEntry) continue;
    const commodity = commodityMap.get(firstEntry.commodity_guid);
    const ticker = commodity?.mnemonic ?? "???";
    const commodityPrices = priceByMonth.get(firstEntry.commodity_guid);
    const txCurrencyGuid = firstEntry.tx_currency_guid;

    let cumulativeShares = 0;
    let cumulativeCost = 0;
    let lastKnownPrice = 0;
    let lastKnownPriceCurrency = txCurrencyGuid;

    for (const month of sortedMonths) {
      const delta = monthlyData.get(month);
      if (delta) {
        cumulativeShares += delta.shares;
        cumulativeCost += delta.cost;
      }

      const priceThisMonth = commodityPrices?.get(month);
      if (priceThisMonth !== undefined) {
        lastKnownPrice = priceThisMonth.price;
        lastKnownPriceCurrency = priceThisMonth.currencyGuid;
      }

      if (cumulativeShares === 0 && cumulativeCost === 0 && !delta) continue;

      // Convert both value and cost basis to base currency
      const valueInBase = fxRates.toBase(lastKnownPriceCurrency, cumulativeShares * lastKnownPrice);
      const costInBase = fxRates.toBase(txCurrencyGuid, cumulativeCost);

      result.push({
        month,
        ticker,
        value: valueInBase,
        costBasis: costInBase,
      });
    }
  }

  for (const account of valuationMonthly.values()) {
    let cumulativeBalance = 0;
    let started = false;
    for (const month of sortedMonths) {
      const delta = account.months.get(month);
      if (delta !== undefined) {
        cumulativeBalance += delta;
        started = true;
      }
      if (!started) continue;
      result.push({
        month,
        ticker: account.accountName,
        value: fxRates.toBase(account.commodityGuid, cumulativeBalance),
        costBasis: 0,
        valuationOnly: true,
      });
    }
  }

  return result;
}
