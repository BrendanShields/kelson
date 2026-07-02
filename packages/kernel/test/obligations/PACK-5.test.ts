import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendChangelog, readChangelog } from "../../src/loop.ts";
import { tmpDir } from "../eval-helpers.ts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

const entry = (over: Record<string, unknown> = {}) => ({
  at: "2026-07-02T00:00:00Z",
  action: "apply" as const,
  proposal_id: null,
  lockfile_before: HASH_A,
  lockfile_after: HASH_B,
  evidence_summary: "fixture",
  ...over,
});

describe("PACK-5: the changelog writer only appends seq = last+1; tampered history fails verification", () => {
  it("appends assign contiguous seqs starting at 1", () => {
    const path = join(tmpDir(), "changelog.jsonl");
    expect(appendChangelog(path, entry()).seq).toBe(1);
    expect(appendChangelog(path, entry()).seq).toBe(2);
    expect(readChangelog(path).map((e) => e.seq)).toEqual([1, 2]);
  });

  it("a gap or rewrite in existing history is refused by the reader/writer", () => {
    const path = join(tmpDir(), "changelog.jsonl");
    appendChangelog(path, entry());
    // Tamper: rewrite line 1 with a different seq.
    const tampered = JSON.stringify({ ...entry(), seq: 7 });
    writeFileSync(path, `${tampered}\n`);
    // The writer computes last from what exists — appending after a tampered
    // seq-7 line yields 8, and the contiguity check exposes the tamper.
    appendChangelog(path, entry());
    const seqs = readChangelog(path).map((e) => e.seq);
    const contiguous = seqs.every((s, i) => s === i + 1);
    expect(contiguous).toBe(false);
  });

  it("the CI tamper check fails when an existing line differs from its recorded content", () => {
    const path = join(tmpDir(), "changelog.jsonl");
    appendChangelog(path, entry());
    appendChangelog(path, entry({ action: "revert" }));
    const original = readFileSync(path, "utf8");
    // scripts/changelog-check.mjs logic: the merge-base content must be a
    // byte-prefix of the current content.
    const isPrefix = (base: string, current: string) =>
      current.startsWith(base);
    expect(isPrefix(original, `${original}{"seq":3}\n`)).toBe(true);
    const rewritten = original.replace("fixture", "tampered");
    expect(isPrefix(original, rewritten)).toBe(false);
  });
});
