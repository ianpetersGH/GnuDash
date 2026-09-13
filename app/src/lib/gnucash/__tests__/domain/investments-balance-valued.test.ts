import Database from "better-sqlite3";
import { copyFileSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { buildParseContext } from "../../context";
import { openAndValidate } from "../../db/connection";
import {
  computeInvestments,
  computeInvestmentValueSeries,
} from "../../domain/investments";
import { FIXTURE_PATH } from "../helpers";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("balance-valued investment accounts", () => {
  it("includes ASSET accounts below Investments without inventing returns", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gnudash-investments-"));
    tempDirs.push(dir);
    const fixture = path.join(dir, "valuation.gnucash");
    copyFileSync(FIXTURE_PATH, fixture);

    const setupDb = new Database(fixture);
    const investmentParent = setupDb
      .prepare("SELECT guid FROM accounts WHERE name = 'Investments'")
      .get() as { guid: string };
    const equityAccount = setupDb
      .prepare("SELECT guid FROM accounts WHERE name = 'Opening Balances'")
      .get() as { guid: string };
    const currency = setupDb
      .prepare("SELECT guid FROM commodities WHERE mnemonic = 'GBP'")
      .get() as { guid: string };

    const accountGuid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const txGuid = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    setupDb
      .prepare(
        "INSERT INTO accounts (guid, name, account_type, commodity_guid, parent_guid, placeholder) VALUES (?, ?, 'ASSET', ?, ?, 0)"
      )
      .run(accountGuid, "Managed Portfolio", currency.guid, investmentParent.guid);
    setupDb
      .prepare(
        "INSERT INTO transactions (guid, currency_guid, post_date, enter_date, description) VALUES (?, ?, ?, ?, ?)"
      )
      .run(txGuid, currency.guid, "2026-03-14 00:00:00", "2026-03-14 00:00:00", "Valuation update");
    setupDb
      .prepare(
        "INSERT INTO splits (guid, tx_guid, account_guid, value_num, value_denom, quantity_num, quantity_denom) VALUES (?, ?, ?, ?, 100, ?, 100)"
      )
      .run("cccccccccccccccccccccccccccccccc", txGuid, accountGuid, 123456, 123456);
    setupDb
      .prepare(
        "INSERT INTO splits (guid, tx_guid, account_guid, value_num, value_denom, quantity_num, quantity_denom) VALUES (?, ?, ?, ?, 100, ?, 100)"
      )
      .run("dddddddddddddddddddddddddddddddd", txGuid, equityAccount.guid, -123456, -123456);
    setupDb.close();

    const db = openAndValidate(fixture);
    const ctx = buildParseContext(db);
    const holding = computeInvestments(ctx).find(
      (item) => item.accountName === "Managed Portfolio"
    );
    const series = computeInvestmentValueSeries(ctx).filter(
      (item) => item.ticker === "Managed Portfolio"
    );

    expect(holding).toMatchObject({
      ticker: "Managed Portfolio",
      marketValue: 1234.56,
      costBasis: 0,
      gainLoss: 0,
      valuationOnly: true,
    });
    expect(series.at(-1)).toMatchObject({
      month: "2026-03",
      value: 1234.56,
      costBasis: 0,
      valuationOnly: true,
    });
    db.close();
  });
});
