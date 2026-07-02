import { describe, expect, it } from "bun:test";
import { Lockfile } from "@kelson/schemas";
import { hashLockfile } from "../../src/packs.ts";

// A lockfile authored under an earlier kernel, byte-frozen here. A kernel
// upgrade that changes this hash would silently re-pin every project.
const OLD_LOCKFILE = {
  schema_version: 1,
  parent_hash: null,
  entries: [
    {
      name: "ponytail",
      version: "4.7.0",
      hash: `sha256:${"0".repeat(64)}`,
      enabled: true,
    },
  ],
};
const FROZEN_HASH =
  "sha256:7e7f88c9d5905e9e2376c5bd766df908ebf4c1ce83811f78d385bcaf26000d9f";

describe("OSS-3: kernel and packs semver independently; a pinned project runs unchanged across kernel upgrades", () => {
  it("an old lockfile parses under the current kernel and its hash is stable", () => {
    const parsed = Lockfile.parse(OLD_LOCKFILE);
    expect(hashLockfile(parsed)).toBe(hashLockfile(OLD_LOCKFILE));
    expect(hashLockfile(OLD_LOCKFILE)).toBe(FROZEN_HASH);
  });

  it("kernel upgrades never auto-apply: nothing in the kernel mutates a lockfile outside the proposal path", async () => {
    const src = await Bun.file(
      new URL("../../src/index.ts", import.meta.url).pathname,
    ).text();
    // The only lockfile writers are loop.ts apply/revert (proposal path).
    const { execSync } = await import("node:child_process");
    const writers = execSync(
      "grep -rln 'writeFileSync(ctx.lockfilePath' src/",
      { cwd: new URL("../..", import.meta.url).pathname },
    )
      .toString()
      .trim()
      .split("\n");
    expect(writers).toEqual(["src/loop.ts"]);
    expect(src.length).toBeGreaterThan(0);
  });
});
