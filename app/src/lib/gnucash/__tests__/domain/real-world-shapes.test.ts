import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildParseContext } from "../../context";
import { openAndValidate } from "../../db/connection";
import { toDayKey } from "../../domain/orphan-prices";
import { FIXTURE_PATH } from "../helpers";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("real-world GnuCash shapes", () => {
  it("falls back to an actual currency GUID when the root commodity is absent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gnudash-context-"));
    tempDirs.push(dir);
    const fixture = path.join(dir, "missing-root-currency.gnucash");
    copyFileSync(FIXTURE_PATH, fixture);

    const setupDb = new Database(fixture);
    const rootGuid = setupDb.prepare("SELECT root_account_guid FROM books LIMIT 1").pluck().get() as string;
    setupDb.prepare("UPDATE accounts SET commodity_guid = ? WHERE guid = ?").run(
      "ffffffffffffffffffffffffffffffff",
      rootGuid
    );
    const expected = setupDb
      .prepare("SELECT guid, mnemonic FROM commodities WHERE mnemonic = 'GBP'")
      .get() as { guid: string; mnemonic: string };
    setupDb.close();

    const db = openAndValidate(fixture);
    const ctx = buildParseContext(db);
    expect(ctx.baseCurrencyGuid).toBe(expected.guid);
    expect(ctx.baseCurrencyMnemonic).toBe(expected.mnemonic);
    db.close();
  });

  it("keeps distinct ISO calendar days distinct for orphan-price matching", () => {
    expect(toDayKey("2026-09-03 00:00:00")).toBe("20260903");
    expect(toDayKey("2026-09-30 00:00:00")).toBe("20260930");
    expect(toDayKey("20260903000000")).toBe("20260903");
  });
});
