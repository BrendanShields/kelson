import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadPack } from "../../src/packs.ts";
import { tmpDir } from "../eval-helpers.ts";

export const makePack = (
  capabilities: string[],
  files: Record<string, string>,
  description = "fixture",
): string => {
  const dir = tmpDir();
  writeFileSync(
    join(dir, "pack.yaml"),
    JSON.stringify({
      schema_version: 1,
      name: "fixture-pack",
      version: "1.0.0",
      kind: "efficiency",
      kernel_compat: "*",
      capabilities,
      description,
    }),
  );
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
};

describe("SEC-4: packs declare capabilities; content addressing undeclared surfaces is refused naming the excess", () => {
  it("undeclared routing content is refused with the surface and path named", () => {
    const dir = makePack(["rules"], {
      "rules/style.md": "be terse",
      "routing/policy.yaml": "schema_version: 1",
    });
    expect(() => loadPack(dir)).toThrow(
      /routing-table.*routing\/policy\.yaml|routing\/policy\.yaml.*routing-table/s,
    );
  });

  it("undeclared agent-registry content is refused", () => {
    const dir = makePack(["routing-table"], {
      "routing/policy.yaml": "x: 1",
      "agents/extra.yaml": "x: 1",
    });
    expect(() => loadPack(dir)).toThrow(/agent-registry/);
  });

  it("prose ABOUT a surface does not address it — path decides, never content (pack-format §3.1)", () => {
    const dir = makePack(["rules"], {
      "rules/models.md": "always route to opus for build steps",
    });
    expect(loadPack(dir).manifest.name).toBe("fixture-pack");
  });

  it("ceiling semantics: declared-but-absent capability loads fine; docs allowlist is invisible", () => {
    const dir = makePack(["rules", "eval-suite"], {
      "rules/a.md": "x",
      "README.md": "documentation",
      "docs/guide.md": "more documentation",
      LICENSE: "MIT",
    });
    expect(loadPack(dir).files).toContain("README.md");
  });

  it("unmapped non-doc paths are refused fail-closed", () => {
    const dir = makePack(["rules"], { "scripts/run.sh": "#!/bin/sh" });
    expect(() => loadPack(dir)).toThrow(/no capability mapping/);
  });

  it("docs-allowlist near-misses stay fail-closed (anchored, not prefix)", () => {
    for (const path of [
      "README.mdx",
      "LICENSE-evil.sh",
      "CHANGELOG.mdfoo/rules.yaml",
    ]) {
      const dir = makePack(["rules"], { [path]: "x" });
      expect(() => loadPack(dir), path).toThrow(
        /no capability mapping|pack layout error/,
      );
    }
  });
});
