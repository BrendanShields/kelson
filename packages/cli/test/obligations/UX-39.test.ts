import { describe, expect, it } from "bun:test";
import { fatalGuard } from "../../src/chat/app.js";

const recorder = () => {
  const calls: string[] = [];
  return {
    calls,
    renderer: {
      destroy: () => {
        calls.push("destroy");
      },
    },
    write: (line: string) => {
      calls.push(`write:${line}`);
    },
    exit: (code: number) => {
      calls.push(`exit:${code}`);
    },
  };
};

describe("UX-39: fatal guard — restore terminal, classified line, exit 1, once-latched", () => {
  it("destroy, then fatal: headline, then exit(1) — in order", () => {
    const r = recorder();
    const guard = fatalGuard(r.renderer, r.write, r.exit);
    guard(new Error("boom"));
    // revert-check: write before destroy → the line lands on the alt screen
    // and this order assertion fails.
    expect(r.calls).toEqual(["destroy", "write:fatal: boom\n", "exit:1"]);
  });

  it("classification is shared with UX-37, not re-derived", () => {
    const r = recorder();
    fatalGuard(r.renderer, r.write, r.exit)(new Error("HTTP 429 rate limit"));
    expect(r.calls[1]).toBe(
      "write:fatal: rate-limited — the endpoint refused the request\n",
    );
  });

  it("a throwing destroy still writes and exits 1", () => {
    const r = recorder();
    const guard = fatalGuard(
      {
        destroy: () => {
          throw new Error("teardown died");
        },
      },
      r.write,
      r.exit,
    );
    guard(new Error("boom"));
    // revert-check: drop the try/catch → exit never records.
    expect(r.calls).toEqual(["write:fatal: boom\n", "exit:1"]);
  });

  it("once-latched: a second fatal skips destroy/write, still exits", () => {
    const r = recorder();
    const guard = fatalGuard(r.renderer, r.write, r.exit);
    guard(new Error("first"));
    guard(new Error("second"));
    expect(r.calls).toEqual([
      "destroy",
      "write:fatal: first\n",
      "exit:1",
      "exit:1",
    ]);
  });
});
