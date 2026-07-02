import { describe, expect, it } from "bun:test";
import type { SandboxProfile } from "@kelson/schemas";
import {
  containerRuntime,
  createWorkspace,
  SandboxRefusal,
} from "../../src/sandbox.ts";
import { makeSnapshot, tmpDir } from "../eval-helpers.ts";

const store = tmpDir();
const snapshot = makeSnapshot({ "README.md": "x\n" }, store);
const docker = containerRuntime() !== null;

describe("SEC-2: community-suite sandbox denies network except the task allowlist", () => {
  it.skipIf(!docker)(
    "non-allowlisted egress is blocked under deny",
    () => {
      const profile: SandboxProfile = {
        isolation: "container",
        network: { policy: "deny", allowlist: [] },
      };
      const ws = createWorkspace(profile, { snapshot, storeDir: store });
      try {
        const res = ws.exec(
          `bun -e "await fetch('https://example.com').then(() => process.exit(0), () => process.exit(7))"`,
          { timeoutMs: 30_000 },
        );
        expect(res.exitCode).not.toBe(0);
      } finally {
        ws.cleanup();
      }
    },
    180_000,
  );

  it("a non-empty allowlist refuses rather than silently allowing (v1 supports full deny only)", () => {
    const profile: SandboxProfile = {
      isolation: "container",
      network: { policy: "deny", allowlist: ["registry.npmjs.org"] },
    };
    if (!docker) {
      // Without a runtime the container refusal fires first — still a refusal,
      // never a silent fallback.
      expect(() =>
        createWorkspace(profile, { snapshot, storeDir: store }),
      ).toThrow(SandboxRefusal);
      return;
    }
    expect(() =>
      createWorkspace(profile, { snapshot, storeDir: store }),
    ).toThrow(/allowlist/);
  });
});
