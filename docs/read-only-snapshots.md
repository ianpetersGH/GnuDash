# Production read-only snapshot mode

This fork preserves the upstream MIT license and reporting views while adding a
build-time deployment profile for GnuCash-authoritative environments.

Build the root `Dockerfile`. It sets:

```text
NEXT_PUBLIC_PRODUCTION_SNAPSHOT_MODE=true
NEXT_PUBLIC_SNAPSHOT_MANIFEST_URL=/snapshots/manifest.json
```

In this mode the app automatically fetches a version-1 manifest, validates its
shape, fetches exactly one personal and one LLC SQLite snapshot, verifies each
size and SHA-256 digest, checks SQLite magic and the GnuCash engine schema, then
loads each book in a separate in-memory worker. Snapshot bytes are never written
to OPFS. The manifest and snapshots are served with `Cache-Control: no-store`.
A failed refresh retains the last loaded reports.

The Personal, LLC, and All workspaces reuse upstream net worth,
income/expenses, spending/merchant, cash-flow, budget, investment, account, and
register reporting. The added Reports & quality view publishes separate book
controls, LLC owner-event candidates, operational queues, and a visible
consolidation bridge. All reporting can drill to transaction splits and account
paths in the snapshot.

Consolidation is intentionally conservative. It sums verified book controls and
applies only manifest entries whose status is `verified` and currency matches.
Pending/unknown entries are excluded, absent pairing evidence eliminates
nothing, and limitations visibly qualify the result. Cross-book budgets are not
blended.

Account, transaction, commodity, price, and budget mutation requests are
rejected in both React context and the SQLite worker. Mutation/export/upload and
Postgres affordances are hidden from the production navigation. The container
must mount only the generated snapshot directory read-only; never mount the
canonical books.

See the companion deployment, manifest schema, online-backup pipeline, systemd
user units, synthetic fixtures, and operator runbook in
`ianpetersGH/homelab/roles/finance-dashboard`.
