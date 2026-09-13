"use client";

import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import type { InvestmentHolding } from "@/lib/types/gnucash";

interface PortfolioSummaryProps {
  holdings: InvestmentHolding[];
  currency: string;
}

export function PortfolioSummary({ holdings, currency }: PortfolioSummaryProps) {
  const stats = useMemo(() => {
    const totalMarketValue = holdings.reduce((s, h) => s + h.marketValue, 0);
    const pricedHoldings = holdings.filter((h) => !h.valuationOnly);
    const pricedMarketValue = pricedHoldings.reduce((s, h) => s + h.marketValue, 0);
    const totalCostBasis = pricedHoldings.reduce((s, h) => s + h.costBasis, 0);
    const totalGainLoss = pricedMarketValue - totalCostBasis;
    const totalReturnPct = totalCostBasis !== 0
      ? (totalGainLoss / Math.abs(totalCostBasis)) * 100
      : 0;
    return {
      totalMarketValue,
      totalCostBasis,
      totalGainLoss,
      totalReturnPct,
      hasPricedHoldings: pricedHoldings.length > 0,
    };
  }, [holdings]);

  const cards = [
    { label: "Recorded Value", value: formatCurrency(stats.totalMarketValue, currency) },
    {
      label: "Known Cost Basis",
      value: stats.hasPricedHoldings ? formatCurrency(stats.totalCostBasis, currency) : "Unavailable",
    },
    {
      label: "Total Gain/Loss",
      value: stats.hasPricedHoldings ? formatCurrency(stats.totalGainLoss, currency) : "Unavailable",
      color: stats.totalGainLoss >= 0 ? "#6C9B8B" : "#F87171",
    },
    {
      label: "Total Return",
      value: stats.hasPricedHoldings
        ? `${stats.totalReturnPct >= 0 ? "+" : ""}${stats.totalReturnPct.toFixed(1)}%`
        : "Unavailable",
      color: stats.totalReturnPct >= 0 ? "#6C9B8B" : "#F87171",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
      {cards.map((c) => (
        <Card key={c.label} className="border-[#EFEFEF] p-4 shadow-sm">
          <p className="text-xs text-[#9A9FA5]">{c.label}</p>
          <p
            className="mt-1 text-lg font-bold sm:text-xl"
            style={{ color: c.color ?? "#1A1D1F" }}
            data-v
          >
            {c.value}
          </p>
        </Card>
      ))}
    </div>
  );
}
