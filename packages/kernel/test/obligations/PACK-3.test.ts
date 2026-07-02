import { describe, expect, it } from "bun:test";
import { loadPack } from "../../src/packs.ts";
import { bumpSatisfies, requiredBump } from "../../src/supply.ts";
import { makePack } from "./SEC-4.test.ts";

describe("PACK-3: required bump computed from manifest + content diffs; declared bump below required fails", () => {
  it("capabilities change → major; content change → minor; identical → none", () => {
    const v1 = loadPack(makePack(["rules"], { "rules/a.md": "x" }));
    const v2content = loadPack(makePack(["rules"], { "rules/a.md": "y" }));
    const v2caps = loadPack(
      makePack(["rules", "eval-suite"], { "rules/a.md": "x" }),
    );
    const v2same = loadPack(makePack(["rules"], { "rules/a.md": "x" }));
    expect(requiredBump(v1, v2content)).toBe("minor");
    expect(requiredBump(v1, v2caps)).toBe("major");
    expect(requiredBump(v1, v2same)).toBe("none");
    // Manifest-metadata-only (description tweak, identical entries) → patch.
    const v2meta = loadPack(
      makePack(["rules"], { "rules/a.md": "x" }, "fixture v2 description"),
    );
    expect(requiredBump(v1, v2meta)).toBe("patch");
  });

  it("declared bump lower than required is rejected; sufficient bumps pass", () => {
    expect(bumpSatisfies({ prev: "1.0.0", next: "1.0.1" }, "minor")).toBe(
      false,
    );
    expect(bumpSatisfies({ prev: "1.0.0", next: "1.1.0" }, "minor")).toBe(true);
    expect(bumpSatisfies({ prev: "1.1.0", next: "1.2.0" }, "major")).toBe(
      false,
    );
    expect(bumpSatisfies({ prev: "1.1.0", next: "2.0.0" }, "major")).toBe(true);
    expect(bumpSatisfies({ prev: "1.0.0", next: "1.0.0" }, "none")).toBe(true);
  });
});
