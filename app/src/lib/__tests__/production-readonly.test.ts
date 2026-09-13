import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("production snapshot safety gates", () => {
  it("builds the deployed image in snapshot mode", () => {
    const dockerfile = read("../Dockerfile");
    expect(dockerfile).toContain("NEXT_PUBLIC_PRODUCTION_SNAPSHOT_MODE=true");
    expect(dockerfile).toContain("NEXT_PUBLIC_SNAPSHOT_MANIFEST_URL=/snapshots/manifest.json");
  });

  it("rejects mutations in both context and worker", () => {
    const context = read("src/lib/dashboard-context.tsx");
    const worker = read("src/lib/gnucash/worker/db-worker.ts");
    expect(context).toContain("PRODUCTION_SNAPSHOT_MODE || !isWritable");
    expect(context).toContain("Manual uploads are disabled in production snapshot mode");
    expect(worker).toContain("Mutations are disabled in production snapshot mode");
  });

  it("loads snapshots in memory instead of OPFS", () => {
    const worker = read("src/lib/gnucash/worker/db-worker.ts");
    const client = read("src/lib/gnucash/worker/client.ts");
    expect(client).toContain('type: "init-memory-readonly"');
    expect(worker).toContain("function initFromReadOnlyBuffer");
    expect(worker).toContain("createWasmAdapter(db)");
  });
});
