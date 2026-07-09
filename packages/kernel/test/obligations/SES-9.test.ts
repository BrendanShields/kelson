import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreSnapshot, storeSnapshot } from "../../src/snapshots.ts";
import { makeRepo, tmpDir } from "../eval-helpers.ts";

// storeSnapshot writes `kelson-bundle-<pid>-<ts>.bundle` under os.tmpdir();
// realpath the dir before listing — macOS /tmp is a symlink to /private/tmp.
const TEMP_ROOT = realpathSync(tmpdir());
const OWN_PREFIX = `kelson-bundle-${process.pid}-`;
const bundleEntries = () =>
  new Set(readdirSync(TEMP_ROOT).filter((e) => e.startsWith(OWN_PREFIX)));
const leakedSince = (before: Set<string>): string[] =>
  [...bundleEntries()].filter((e) => !before.has(e));

describe("SES-9: storeSnapshot leaves no temp bundle outside the store, success or error", () => {
  it("success: the temp location gains no new entries and the snapshot still restores", () => {
    const store = tmpDir();
    const repo = makeRepo({ "README.md": "ses-9\n" });
    const before = bundleEntries();
    const hash = storeSnapshot(repo, store);
    // revert-check: drop the finally-cleanup in snapshots.ts storeSnapshot →
    // this leakedSince assertion fails with the orphaned bundle name.
    expect(leakedSince(before)).toEqual([]);
    const dest = join(tmpDir(), "restored");
    restoreSnapshot(hash, dest, store);
    expect(existsSync(join(dest, "README.md"))).toBe(true);
  });

  it("fault-injected copy failure: the error propagates and the temp location gains no new entries", () => {
    const store = tmpDir();
    const repo = makeRepo({ "README.md": "ses-9-fault\n" });
    // Read-only store dir: mkdirSync(recursive) no-ops on the existing dir,
    // so the bundle is created in temp first and copyFileSync then EACCESes —
    // the real copy-into-store step fails, not a mock of it.
    chmodSync(store, 0o555);
    const before = bundleEntries();
    try {
      expect(() => storeSnapshot(repo, store)).toThrow();
      // revert-check: drop the finally-cleanup → this assertion fails; the
      // error-propagation assertion above holds with or without the fix.
      expect(leakedSince(before)).toEqual([]);
    } finally {
      chmodSync(store, 0o755);
    }
  });
});
