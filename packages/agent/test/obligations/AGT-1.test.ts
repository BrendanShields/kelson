import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runTurn } from "../../src/loop.ts";
import { fixture, textResponse, toolCallResponse } from "../helpers.ts";

describe("AGT-1: one step = one model call; loop control never delegated to the SDK", () => {
  it("a two-step exchange (tool call, then final answer) makes exactly 2 provider invocations", async () => {
    const f = fixture([
      toolCallResponse([{ id: "c1", name: "ls", input: { path: "." } }]),
      textResponse("done"),
    ]);
    const result = await runTurn(f.deps);
    expect(result.status).toBe("done");
    expect(f.model.doStreamCalls.length).toBe(2);
  });

  // Proxy (named): the SDK's loop-control surface is stopWhen/maxSteps —
  // narrow this scan if the SDK renames it.
  it("agent sources contain no SDK loop-control usage (stopWhen/maxSteps)", () => {
    const srcDir = join(import.meta.dir, "..", "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(dir, entry.name));
        else if (entry.name.endsWith(".ts")) files.push(join(dir, entry.name));
      }
    };
    walk(srcDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/\bstopWhen\b|\bmaxSteps\b/);
    }
  });
});
