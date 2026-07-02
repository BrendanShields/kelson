import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../eval-helpers.ts";

const ROOT = join(import.meta.dir, "../../../..");

describe("OSS-4: a PR adding a pack without reproducible eval evidence fails CI", () => {
  it("the contribution gate passes on the real repo (every pack has ledger evidence)", () => {
    execSync("node scripts/contribution-check.mjs", {
      cwd: ROOT,
      stdio: "pipe",
    });
  });

  it("a pack without a ledger entry fails the gate naming the missing evidence", () => {
    const fixture = tmpDir();
    mkdirSync(join(fixture, "packs", "evidence-free"), { recursive: true });
    writeFileSync(
      join(fixture, "packs", "evidence-free", "pack.yaml"),
      "schema_version: 1\nname: evidence-free\nversion: 1.0.0\nkind: efficiency\nkernel_compat: '*'\ncapabilities: [rules]\ndescription: no evidence\n",
    );
    let failed = false;
    let output = "";
    try {
      execSync(`node ${join(ROOT, "scripts/contribution-check.mjs")}`, {
        cwd: fixture,
        stdio: "pipe",
      });
    } catch (e) {
      failed = true;
      output = (e as { stderr: Buffer }).stderr.toString();
    }
    expect(failed).toBe(true);
    expect(output).toContain("evidence-free: no eval evidence");
    expect(output).toContain("OSS-4");
  });
});
