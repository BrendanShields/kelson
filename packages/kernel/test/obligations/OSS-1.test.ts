import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../eval-helpers.ts";

const ROOT = join(import.meta.dir, "../../../..");
const CLI = join(ROOT, "packages/cli/src/index.ts");

describe("OSS-1: one-command install — non-destructive layering over existing Claude Code config", () => {
  it("init on a clean dir creates the store, lockfile, and hooks", () => {
    const dir = tmpDir();
    execSync(`bun ${CLI} init --dir ${dir}`, { stdio: "pipe" });
    expect(existsSync(join(dir, ".kelson", "kelson.db"))).toBe(true);
    expect(existsSync(join(dir, "kelson.lock"))).toBe(true);
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude", "settings.json"), "utf8"),
    ) as { hooks: Record<string, unknown[]> };
    expect(settings.hooks.SessionStart).toHaveLength(1);
  });

  it("init detects existing config and layers non-destructively (idempotent, preserves foreign hooks)", () => {
    const dir = tmpDir();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const existing = {
      model: "opus",
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "echo my-precious-hook" }] },
        ],
      },
    };
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify(existing),
    );
    writeFileSync(
      join(dir, "kelson.lock"),
      '{"schema_version":1,"parent_hash":null,"entries":[]}',
    );
    const lockBefore = readFileSync(join(dir, "kelson.lock"), "utf8");
    execSync(`bun ${CLI} init --dir ${dir}`, { stdio: "pipe" });
    execSync(`bun ${CLI} init --dir ${dir}`, { stdio: "pipe" }); // idempotent
    const settings = JSON.parse(
      readFileSync(join(dir, ".claude", "settings.json"), "utf8"),
    ) as {
      model: string;
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    expect(settings.model).toBe("opus");
    const commands = settings.hooks.SessionStart.flatMap((h) =>
      h.hooks.map((x) => x.command),
    );
    expect(commands).toContain("echo my-precious-hook");
    expect(commands.filter((c) => c.includes("session-start")).length).toBe(1);
    expect(readFileSync(join(dir, "kelson.lock"), "utf8")).toBe(lockBefore);
  });
});
