"use client";

import Link from "next/link";
import { useMemo } from "react";
import { AlertTriangle, CheckCircle2, Clock3, Database, ExternalLink, ShieldAlert } from "lucide-react";
import { useDashboard } from "@/lib/dashboard-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";

function includesPath(path: string, terms: string[]): boolean {
  const normalized = path.toLowerCase();
  return terms.some((term) => normalized.includes(term));
}

function priceTimestamp(value: string): number {
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compact) return Date.UTC(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]));
  return Date.parse(value);
}

function oldestManualValuationAgeDays(prices: NonNullable<ReturnType<typeof useDashboard>["data"]>["prices"]): number | null {
  const latestByCommodity = new Map<string, number>();
  for (const price of prices.filter((row) => row.source?.toLowerCase().includes("user"))) {
    const timestamp = priceTimestamp(price.date);
    if (Number.isFinite(timestamp) && timestamp > (latestByCommodity.get(price.commodity_guid) ?? 0)) latestByCommodity.set(price.commodity_guid, timestamp);
  }
  if (!latestByCommodity.size) return null;
  return Math.max(...[...latestByCommodity.values()].map((timestamp) => Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000))));
}

function QualityCard({ title, value, detail, unknown = false }: { title: string; value: number | string; detail: string; unknown?: boolean }) {
  return (
    <Card>
      <CardHeader className="pb-2"><CardTitle className="flex items-center justify-between text-sm">{title}{unknown ? <ShieldAlert className="h-4 w-4 text-amber-500" /> : <CheckCircle2 className="h-4 w-4 text-[#6C9B8B]" />}</CardTitle></CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold" data-v>{value}</div>
        <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
        <Link href="/transactions" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[#3B6B8A]">Drill through to splits <ExternalLink className="h-3 w-3" /></Link>
      </CardContent>
    </Card>
  );
}

export default function ReportsPage() {
  const { data, dataByBook, bookScope, snapshotManifest, consolidationBridge, uploadedAt } = useDashboard();
  const metrics = useMemo(() => {
    if (!data) return null;
    const splits = data.ledgerTransactions.flatMap((tx) => tx.splits);
    const count = (terms: string[]) => splits.filter((split) => includesPath(split.accountFullPath, terms)).length;
    const ownerEvents = (dataByBook?.business.ledgerTransactions ?? []).filter((tx) => tx.splits.some((split) => includesPath(split.accountFullPath, ["owner", "member", "contribution", "draw", "due to", "due from", "reimbursement"])));
    const manualAge = oldestManualValuationAgeDays(data.prices);
    return {
      uncategorized: count(["uncategorized", "unassigned"]),
      transferReview: count(["transfer review"]),
      debtReview: count(["debt review"]),
      ownerEvents,
      manualAge,
      splitCount: splits.length,
    };
  }, [data, dataByBook]);

  if (!data || !metrics) return null;
  const c = data.currency;
  const op = snapshotManifest?.operational;
  const staleManual = metrics.manualAge !== null && op ? metrics.manualAge > op.manual_valuation_warn_days : false;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold">Reporting & data quality</h1>
        <p className="mt-1 text-sm text-muted-foreground">{bookScope === "business" ? "LLC" : bookScope === "all" ? "Consolidated / all" : "Personal"} workspace · each control links to split-level provenance.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <QualityCard title="Snapshot freshness" value={uploadedAt ? uploadedAt.toLocaleString() : "Unknown"} detail="Manifest and both snapshot digests are revalidated on refresh." unknown={!uploadedAt} />
        <QualityCard title="Transactions / splits" value={`${data.ledgerTransactions.length} / ${metrics.splitCount}`} detail="Full in-snapshot provenance available in the transaction drill-through." />
        <QualityCard title="Snapshot failures" value={op?.snapshot_failures ?? "Unknown"} detail="A failed rebuild leaves the prior atomic snapshot set in place." unknown={!op || op.snapshot_failures > 0} />
        <QualityCard title="Uncategorized" value={metrics.uncategorized} detail="Splits posted to explicit Uncategorized or Unassigned paths." unknown={metrics.uncategorized > 0} />
        <QualityCard title="Transfer Review" value={metrics.transferReview} detail="Transfers deliberately held for owner review; no inferred match is applied." unknown={metrics.transferReview > 0} />
        <QualityCard title="Debt review" value={metrics.debtReview} detail="Debt-related splits carrying an explicit review marker." unknown={metrics.debtReview > 0} />
        <QualityCard title="Stale feeds" value={op?.stale_feeds ?? "Unknown"} detail="Unknown means feed evidence was not supplied to the snapshot pipeline." unknown={op?.stale_feeds === null || op?.stale_feeds === undefined || (op?.stale_feeds ?? 0) > 0} />
        <QualityCard title="Failed imports" value={op?.failed_imports ?? "Unknown"} detail="Unknown is visible rather than silently treated as zero." unknown={op?.failed_imports === null || op?.failed_imports === undefined || (op?.failed_imports ?? 0) > 0} />
        <QualityCard title="Manual valuation age" value={metrics.manualAge === null ? "Unknown" : `${metrics.manualAge} days`} detail={`Warning threshold: ${op?.manual_valuation_warn_days ?? "unknown"} days.`} unknown={metrics.manualAge === null || staleManual} />
      </div>

      {dataByBook && (
        <Card>
          <CardHeader><CardTitle>Personal and LLC controls</CardTitle></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-muted-foreground"><th className="py-2">Scope</th><th>Net worth</th><th>Current income</th><th>Current expenses</th><th>Evidence</th></tr></thead>
              <tbody>
                {(["personal", "business"] as const).map((scope) => { const row = dataByBook[scope]; return (
                  <tr className="border-b" key={scope}><td className="py-2 font-medium">{scope === "business" ? "LLC P&L" : "Personal"}</td><td data-v>{formatCurrency(row.currentNetWorth, row.currency)}</td><td data-v>{formatCurrency(row.currentMonthIncome, row.currency)}</td><td data-v>{formatCurrency(row.currentMonthExpenses, row.currency)}</td><td><Link href="/transactions" className="text-[#3B6B8A]">splits</Link></td></tr>
                ); })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {consolidationBridge && (
        <Card className={consolidationBridge.publication === "qualified" ? "border-amber-400" : "border-emerald-400"}>
          <CardHeader><CardTitle className="flex items-center gap-2">{consolidationBridge.publication === "qualified" ? <AlertTriangle className="h-5 w-5 text-amber-500" /> : <CheckCircle2 className="h-5 w-5 text-emerald-500" />}Consolidated bridge · {consolidationBridge.publication}</CardTitle></CardHeader>
          <CardContent>
            <div className="grid gap-3 md:grid-cols-4">
              <div><p className="text-xs text-muted-foreground">Verified personal</p><p className="font-semibold" data-v>{formatCurrency(consolidationBridge.personalNetWorth, c)}</p></div>
              <div><p className="text-xs text-muted-foreground">Verified LLC</p><p className="font-semibold" data-v>{formatCurrency(consolidationBridge.businessNetWorth, c)}</p></div>
              <div><p className="text-xs text-muted-foreground">Explicit verified eliminations</p><p className="font-semibold" data-v>{formatCurrency(consolidationBridge.verifiedNetWorthEliminations, c)}</p></div>
              <div><p className="text-xs text-muted-foreground">Consolidated</p><p className="font-semibold" data-v>{formatCurrency(consolidationBridge.consolidatedNetWorth, c)}</p></div>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Formula: personal + LLC + explicit verified adjustments. Owner entries are never inferred or blindly eliminated.</p>
            {consolidationBridge.qualificationNotes.length > 0 && <ul className="mt-3 list-disc pl-5 text-xs text-amber-700 dark:text-amber-300">{consolidationBridge.qualificationNotes.map((note) => <li key={note}>{note}</li>)}</ul>}
            {consolidationBridge.unresolvedEliminations.length > 0 && <p className="mt-2 text-xs font-medium text-amber-700">{consolidationBridge.unresolvedEliminations.length} unresolved elimination item(s) excluded from totals.</p>}
            <Link href="/transactions" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[#3B6B8A]">Drill through to both books <ExternalLink className="h-3 w-3" /></Link>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>LLC owner-event review</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-3 text-xs text-muted-foreground">Evidence-based candidates only. Labels are matched from LLC account paths; no accounting or tax conclusion is inferred.</p>
          {metrics.ownerEvents.length === 0 ? <p className="text-sm text-muted-foreground">No explicitly labeled owner events found.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left text-muted-foreground"><th className="py-2">Date</th><th>Description</th><th>Split provenance</th></tr></thead><tbody>{metrics.ownerEvents.slice(0, 100).map((tx) => <tr key={tx.guid} className="border-b"><td className="py-2">{tx.date}</td><td>{tx.description}</td><td>{tx.splits.map((s) => s.accountFullPath).join(" ↔ ")}</td></tr>)}</tbody></table></div>
          )}
          <Link href="/transactions" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[#3B6B8A]">Open full split register <ExternalLink className="h-3 w-3" /></Link>
        </CardContent>
      </Card>

      <div className="flex items-center gap-2 text-xs text-muted-foreground"><Database className="h-4 w-4" />Snapshot engine: SQLite online backup → integrity check → atomic publish → browser digest verification.<Clock3 className="ml-2 h-4 w-4" />Automatic refresh every minute.</div>
    </div>
  );
}
