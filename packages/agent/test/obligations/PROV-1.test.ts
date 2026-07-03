import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, resolveEntry } from "../../src/llm/registry.ts";

describe("PROV-1: registry resolution — shipped models, user overlay wins, unknown refs fail loudly", () => {
  it("a shipped id resolves", () => {
    const registry = loadRegistry(
      join(mkdtempSync(join(tmpdir(), "kelson-reg-")), "none.json"),
    );
    const entry = resolveEntry(registry, "claude-opus-4-8");
    expect(entry.provider).toBe("anthropic");
    expect(entry.context_window).toBe(1_000_000);
  });

  it("an overlay entry shadows the shipped entry with the same id", () => {
    const overlayPath = join(
      mkdtempSync(join(tmpdir(), "kelson-reg-")),
      "models.json",
    );
    writeFileSync(
      overlayPath,
      JSON.stringify([
        {
          id: "claude-opus-4-8",
          provider: "openai-compatible",
          base_url: "http://127.0.0.1:9999/v1",
          context_window: 42,
          max_output: 7,
          prices: null,
          tools: false,
        },
      ]),
    );
    const entry = resolveEntry(loadRegistry(overlayPath), "claude-opus-4-8");
    expect(entry.context_window).toBe(42);
    expect(entry.provider).toBe("openai-compatible");
  });

  it("an unknown ref throws naming the ref and at least one known id", () => {
    const registry = loadRegistry(
      join(mkdtempSync(join(tmpdir(), "kelson-reg-")), "none.json"),
    );
    expect(() => resolveEntry(registry, "gpt-42")).toThrow(/gpt-42/);
    expect(() => resolveEntry(registry, "gpt-42")).toThrow(/claude-opus-4-8/);
  });
});
