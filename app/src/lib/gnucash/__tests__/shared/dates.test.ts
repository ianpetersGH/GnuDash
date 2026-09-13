import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  monthKeyFromGnuCashDate,
  parseGnuCashDate,
  sqlMonth,
  sqlMonthNum,
  sqlYear,
} from "../../shared/dates";

describe("GnuCash date normalization", () => {
  it.each([
    ["20260314153000", "2026-03", "03", "2026"],
    ["2026-03-14 15:30:00", "2026-03", "03", "2026"],
  ])("normalizes %s in SQL", (input, expectedMonth, expectedMonthNum, expectedYear) => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE dates (value TEXT NOT NULL)");
    db.prepare("INSERT INTO dates (value) VALUES (?)").run(input);

    const row = db
      .prepare(
        `SELECT ${sqlMonth("value")} AS month, ${sqlMonthNum("value")} AS month_num, ${sqlYear("value")} AS year FROM dates`
      )
      .get() as { month: string; month_num: string; year: string };

    expect(row).toEqual({
      month: expectedMonth,
      month_num: expectedMonthNum,
      year: expectedYear,
    });
    db.close();
  });

  it.each([
    ["20260314153000", "2026-03"],
    ["2026-03-14 15:30:00", "2026-03"],
  ])("builds a JavaScript month key from %s", (input, expected) => {
    expect(monthKeyFromGnuCashDate(input)).toBe(expected);
  });

  it.each(["20260314153000", "2026-03-14 15:30:00"])(
    "parses %s as the same local calendar date",
    (input) => {
      const date = parseGnuCashDate(input);
      expect([date.getFullYear(), date.getMonth() + 1, date.getDate()]).toEqual([
        2026, 3, 14,
      ]);
    }
  );
});
