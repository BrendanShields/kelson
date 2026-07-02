import { describe, expect, it } from "bun:test";
import type { SandboxProfile } from "@kelson/schemas";
import { createWorkspace, SandboxRefusal } from "../../src/sandbox.ts";
import { makeSnapshot, tmpDir } from "../eval-helpers.ts";

const store = tmpDir();
const snapshot = makeSnapshot({ "README.md": "x\n" }, store);

describe("EVP-2: container required but unavailable → refuse with a diagnostic, never fall back to worktree", () => {
  it("refuses when no container runtime is on PATH", () => {
    const profile: SandboxProfile = {
      isolation: "container",
      network: { policy: "deny", allowlist: [] },
    };
    let threw: unknown = null;
    try {
      createWorkspace(profile, { snapshot, storeDir: store, runtime: null });
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(SandboxRefusal);
    expect((threw as Error).message).toContain("refusing");
    expect((threw as Error).message).toContain("not degrading to worktree");
  });
});
