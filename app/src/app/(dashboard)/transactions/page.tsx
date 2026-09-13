"use client";

import { useMemo, useState } from "react";
import { useDashboard } from "@/lib/dashboard-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/format";

export default function TransactionsPage() {
  const { data, bookScope } = useDashboard();
  const [query, setQuery] = useState("");
  const [reviewOnly, setReviewOnly] = useState(false);
  const rows = useMemo(() => {
    if (!data) return [];
    const needle = query.trim().toLowerCase();
    return data.ledgerTransactions.filter((tx) => {
      const evidence = [tx.description, tx.num, ...tx.splits.flatMap((split) => [split.accountFullPath, split.memo, split.reconcileState])].join(" ").toLowerCase();
      const isReview = /uncategorized|unassigned|transfer review|debt review/.test(evidence);
      return (!needle || evidence.includes(needle)) && (!reviewOnly || isReview);
    });
  }, [data, query, reviewOnly]);

  if (!data) return null;
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold">Transactions & split provenance</h1>
        <p className="mt-1 text-sm text-muted-foreground">Read-only {bookScope === "business" ? "LLC" : bookScope} register. Every displayed total can be traced to these snapshot splits.</p>
      </div>
      <Card>
        <CardHeader><CardTitle>Filter evidence</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Description, account path, memo, check number…" aria-label="Search transactions and splits" />
          <label className="flex shrink-0 items-center gap-2 text-sm"><input type="checkbox" checked={reviewOnly} onChange={(event) => setReviewOnly(event.target.checked)} />Review queues only</label>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-4">
          <p className="mb-3 text-xs text-muted-foreground">Showing {Math.min(rows.length, 500)} of {rows.length} matching transactions. Values remain covered by privacy mode.</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-muted-foreground"><th className="py-2">Date</th><th>Description</th><th>Number</th><th>Splits / provenance</th></tr></thead>
              <tbody>{rows.slice(0, 500).map((tx) => (
                <tr key={tx.guid} className="border-b align-top">
                  <td className="whitespace-nowrap py-2 pr-4">{tx.date}</td>
                  <td className="min-w-48 pr-4">{tx.description}</td>
                  <td className="pr-4">{tx.num}</td>
                  <td className="min-w-80 py-2">
                    <details>
                      <summary className="cursor-pointer text-[#3B6B8A]">{tx.splits.length} split(s)</summary>
                      <div className="mt-2 space-y-1 rounded-lg bg-muted p-2">
                        {tx.splits.map((split, index) => (
                          <div key={`${tx.guid}:${index}`} className="grid grid-cols-[1fr_auto] gap-3 text-xs">
                            <span>{split.accountFullPath}{split.memo ? ` · ${split.memo}` : ""} · reconcile:{split.reconcileState}</span>
                            <span className="font-mono" data-v>{formatCurrency(split.amount, split.commodityMnemonic || data.currency)}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
