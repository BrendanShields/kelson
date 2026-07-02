import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../..");

describe("OSS-5: quickstart, brownfield, pack-author, and safety docs exist; the quickstart executes in CI", () => {
  it("all four operator documents exist", () => {
    for (const doc of [
      "README.md",
      "docs/guides/brownfield.md",
      "docs/guides/pack-author.md",
      "docs/guides/safety-model.md",
    ])
      expect(existsSync(join(ROOT, doc)), doc).toBe(true);
  });

  it("the docs CI wiring exists: quickstart marker + CI step + executable script", () => {
    expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain(
      "quickstart-ci",
    );
    expect(
      readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8"),
    ).toContain("quickstart-check.mjs");
    expect(existsSync(join(ROOT, "scripts/quickstart-check.mjs"))).toBe(true);
  });
});
