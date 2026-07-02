import { describe, expect, it } from "bun:test";
import { compileBundle, recordBundle, TOKENIZER_ID } from "../../src/bundle.ts";
import { openDb } from "../../src/storage.ts";

describe("CTX-5: one pinned tokenizer recorded on every bundle event; empty bundle records exactly zero", () => {
  it("bundle events carry the tokenizer identity", () => {
    const db = openDb(":memory:");
    const event = recordBundle(
      db,
      "t1",
      compileBundle([{ kind: "statement", ref: "s", content: "x" }]),
    );
    expect(event.tokenizer).toBe(TOKENIZER_ID);
    expect(TOKENIZER_ID).toMatch(/o200k_base@gpt-tokenizer@\d+\.\d+\.\d+/);
    const row = db
      .query("SELECT tokenizer FROM bundle_event WHERE id = ?")
      .get(event.id) as { tokenizer: string };
    expect(row.tokenizer).toBe(TOKENIZER_ID);
    db.close();
  });

  it("no bundleable content → empty bundle, zero tokens, empty manifest — never a synthetic preamble", () => {
    const empty = compileBundle([]);
    expect(empty).toEqual({
      text: "",
      token_count: 0,
      manifest: [],
      tokenizer: TOKENIZER_ID,
    });
  });

  it("the CTX-1 comparison runs offline — session-reported usage never participates", () => {
    // Structural check: bundle accounting takes no session/usage input at all.
    const bundle = compileBundle([
      { kind: "clause", ref: "A-1", content: "text" },
    ]);
    expect(typeof bundle.token_count).toBe("number");
    // The only inputs are the items themselves; nothing async, no env, no db.
    expect(compileBundle.length).toBe(1);
  });
});
