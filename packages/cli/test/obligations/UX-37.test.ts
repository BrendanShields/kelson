import { describe, expect, it } from "bun:test";
import { classifyError, createChat, update } from "../../src/chat/model.js";
import { CHAT_THEME } from "../../src/chat/theme.js";
import { transcriptLines } from "../../src/chat/view.js";

const SDK_429 = [
  "AI_RetryError: Failed after 3 attempts. Last error: AI_APICallError: Error",
  '  responseBody: {"type":"error","error":{"type":"rate_limit_error"}}',
  "  statusCode: 429",
  "  at async doStream (…/@ai-sdk/anthropic/dist/index.js:4561:56)",
  "  at async (…/ai/dist/index.js:7993:46)",
].join("\n");

const err = (message: string) =>
  update(createChat("mock-m"), { type: "error", message }).model;

describe("UX-37: classified error panels", () => {
  it("429/rate-limit spew yields row-1 headline and hint verbatim", () => {
    const m = err(SDK_429);
    const e = m.entries[0];
    expect(e?.kind).toBe("error");
    if (e?.kind === "error") {
      // revert-check: drop classification (old `error: ${message}` info) →
      // kind and headline both fail.
      expect(e.headline).toBe(
        "rate-limited — the endpoint refused the request",
      );
      expect(e.hint).toBe(
        "retries exhausted; wait for the usage window to reset, then resend",
      );
    }
    expect(m.busy).toBe(false);
    expect(m.tickCount).toBe(0);
  });

  it("PROV-7 401 message passes its first line through with the re-mint hint", () => {
    const m = err(
      "anthropic auth failed (401) — re-mint with claude setup-token\nsome detail",
    );
    const e = m.entries[0];
    if (e?.kind === "error") {
      expect(e.headline).toBe(
        "anthropic auth failed (401) — re-mint with claude setup-token",
      );
      expect(e.hint).toContain("claude setup-token");
    }
  });

  it("unmatched message: first line (120-cap with …), null hint, exactly 3 detail lines", () => {
    const long = `${"x".repeat(130)}\n\nd1\nd2\nd3\nd4\nd5`;
    const c = classifyError(long);
    expect(c.headline).toBe(`${"x".repeat(120)}…`);
    expect(c.headline.length).toBe(121);
    expect(c.hint).toBeNull();
    // revert-check: keep all lines → d4 leaks and length fails.
    expect(c.detail).toEqual(["d1", "d2", "d3"]);
  });

  it("renders err glyph + err role headline, dim hint (view-level roles)", () => {
    const m = err(SDK_429);
    const lines = transcriptLines(m);
    expect(lines[0]?.[0]?.role).toBe("err");
    expect(lines[0]?.[0]?.text).toContain(CHAT_THEME.glyphs.err);
    expect(lines[0]?.[1]?.text).toBe(
      "rate-limited — the endpoint refused the request",
    );
    expect(lines[1]?.[0]?.role).toBe("dim");
    // Stack frames beyond 3 detail lines never reach the transcript.
    const all = lines
      .flat()
      .map((s) => s.text)
      .join("\n");
    expect(all).not.toContain("7993");
  });
});
