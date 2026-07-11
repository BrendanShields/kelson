import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTestRepo, runCli, type TestRepo } from "../agent-helpers.ts";

interface Seen {
  path: string;
  afterId: string | null;
  auth: string | null;
  xApiKey: string | null;
  beta: string | null;
}

// Serves GET /v1/models one page per request (last page repeats), recording
// what the CLI actually sent — assertions are on what the server saw (F-119).
const detectFixture = (opts: { pages?: unknown[]; status?: number } = {}) => {
  const pages = opts.pages ?? [
    {
      data: [
        {
          id: "claude-new-model",
          max_input_tokens: 500_000,
          max_tokens: 64_000,
        },
      ],
      has_more: false,
    },
  ];
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      seen.push({
        path: url.pathname,
        afterId: url.searchParams.get("after_id"),
        auth: req.headers.get("authorization"),
        xApiKey: req.headers.get("x-api-key"),
        beta: req.headers.get("anthropic-beta"),
      });
      if (url.pathname !== "/v1/models")
        return new Response("no such route", { status: 404 });
      const page = pages[Math.min(seen.length - 1, pages.length - 1)];
      return Response.json(page, { status: opts.status ?? 200 });
    },
  });
  return {
    root: `http://127.0.0.1:${server.port}`,
    seen,
    stop: () => server.stop(true),
  };
};

const login = (t: TestRepo, root: string, extra: string[]) => {
  t.env.OBLIGATO_TEST_ANTHROPIC_ROOT = root;
  delete t.env.CLAUDE_CODE_OAUTH_TOKEN;
  return runCli(t, ["auth", "login", "anthropic", ...extra]);
};

const readOverlay = (t: TestRepo) =>
  JSON.parse(
    readFileSync(join(t.home, ".obligato", "models.json"), "utf8"),
  ) as Record<string, unknown>[];

describe("PROV-12: anthropic login best-effort model detection via GET /v1/models", () => {
  it("(a) paginated list: new id lands mapped, shipped id filtered, no base_url", async () => {
    const f = detectFixture({
      pages: [
        {
          // Shipped id on page 1, new id on page 2 — the new id landing at all
          // proves the has_more/after_id walk ran, not just the first page.
          data: [
            {
              id: "claude-opus-4-8",
              max_input_tokens: 1_000_000,
              max_tokens: 128_000,
            },
          ],
          has_more: true,
          last_id: "claude-opus-4-8",
        },
        {
          data: [
            {
              id: "claude-new-model",
              max_input_tokens: 500_000,
              max_tokens: 64_000,
            },
          ],
          has_more: false,
        },
      ],
    });
    const t = makeTestRepo({});
    const r = await login(t, f.root, ["--token", "tok-prov12"]);
    expect(r.exitCode).toBe(0);

    // Pagination cursor: second request carried the first page's last_id.
    // revert-check: drop the after_id loop in detectAnthropicModels → only one
    // request is made and the overlay-length assertion below fails (no page 2).
    expect(f.seen).toHaveLength(2);
    expect(f.seen[1]?.afterId).toBe("claude-opus-4-8");

    // revert-check: drop the shipped-id filter → overlay has 2 entries.
    const overlay = readOverlay(t);
    expect(overlay).toHaveLength(1);
    const entry = overlay[0] as Record<string, unknown>;
    expect(entry.id).toBe("claude-new-model");
    expect(entry.provider).toBe("anthropic");
    expect(entry.context_window).toBe(500_000);
    expect(entry.max_output).toBe(64_000);
    expect(entry.prices).toBeNull();
    expect(entry.tools).toBe(true);
    // No base_url: a detected entry must not trip PROV-10 override detection.
    // revert-check: set base_url on detected entries → this key-absence fails.
    expect("base_url" in entry).toBe(false);
    f.stop();
  }, 20_000);

  it("(b) header discipline as the server saw it: token → Bearer + OAuth beta, key → x-api-key", async () => {
    const tokenFixture = detectFixture();
    const t1 = makeTestRepo({});
    const r1 = await login(t1, tokenFixture.root, ["--token", "tok-prov12"]);
    expect(r1.exitCode).toBe(0);
    // revert-check: send the token as x-api-key instead → all three fail.
    expect(tokenFixture.seen[0]?.auth).toBe("Bearer tok-prov12");
    expect(tokenFixture.seen[0]?.beta).toBe("oauth-2025-04-20");
    expect(tokenFixture.seen[0]?.xApiKey).toBeNull();
    tokenFixture.stop();

    const keyFixture = detectFixture();
    const t2 = makeTestRepo({});
    const r2 = await login(t2, keyFixture.root, ["--key", "sk-prov12"]);
    expect(r2.exitCode).toBe(0);
    expect(keyFixture.seen[0]?.xApiKey).toBe("sk-prov12");
    expect(keyFixture.seen[0]?.auth).toBeNull();
    keyFixture.stop();
  }, 20_000);

  it("(c) 500, unreachable, and 401 each degrade: exit 0, credential+config persisted, overlay untouched, notice printed", async () => {
    const cases: (() => { root: string; stop: () => void })[] = [
      () => detectFixture({ status: 500 }),
      // Discard-port root: connection refused → the fetch .catch(null) path.
      () => ({ root: "http://127.0.0.1:9", stop: () => {} }),
      () => detectFixture({ status: 401 }),
    ];
    for (const make of cases) {
      const f = make();
      const t = makeTestRepo({});
      const r = await login(t, f.root, ["--token", "tok-prov12"]);
      // revert-check: make detection failure fail the login (PROV-11-style
      // fail-closed) → this exit-code assertion fails on all three cases.
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("model detection skipped");
      expect(existsSync(join(t.home, ".obligato", "auth.json"))).toBe(true);
      expect(existsSync(join(t.repo, ".obligato", "config.json"))).toBe(true);
      expect(existsSync(join(t.home, ".obligato", "models.json"))).toBe(false);
      f.stop();
    }
  }, 30_000);

  it("(d) upsert preserves a pre-existing entry's non-null prices while limits update", async () => {
    const PRICES = { in: 1, out: 2, cache_read: 3, cache_write: 4 };
    const f = detectFixture();
    const t = makeTestRepo({});
    writeFileSync(
      join(t.home, ".obligato", "models.json"),
      JSON.stringify([
        {
          id: "claude-new-model",
          provider: "anthropic",
          context_window: 1_000,
          max_output: 100,
          prices: PRICES,
          tools: true,
        },
      ]),
    );
    const r = await login(t, f.root, ["--key", "sk-prov12"]);
    expect(r.exitCode).toBe(0);
    const overlay = readOverlay(t);
    expect(overlay).toHaveLength(1);
    // Read the stored values back (obligation-test rule): prices byte-identical,
    // limits carry the fixture's values.
    // revert-check: upsert wholesale with prices: null (drop the preservation
    // branch) → the prices equality fails.
    expect(overlay[0]?.prices).toEqual(PRICES);
    expect(overlay[0]?.context_window).toBe(500_000);
    expect(overlay[0]?.max_output).toBe(64_000);
    f.stop();
  }, 20_000);

  it("(e) an element missing max_input_tokens is skipped while its sibling lands", async () => {
    const f = detectFixture({
      pages: [
        {
          data: [
            { id: "claude-partial", max_tokens: 64_000 },
            {
              id: "claude-complete",
              max_input_tokens: 200_000,
              max_tokens: 32_000,
            },
          ],
          has_more: false,
        },
      ],
    });
    const t = makeTestRepo({});
    const r = await login(t, f.root, ["--key", "sk-prov12"]);
    expect(r.exitCode).toBe(0);
    // revert-check: drop the three-field element gate → Zod throws on the
    // partial element, the catch prints the skip notice, and no overlay is
    // written — the length-1 assertion fails.
    const overlay = readOverlay(t);
    expect(overlay).toHaveLength(1);
    expect(overlay[0]?.id).toBe("claude-complete");
    f.stop();
  }, 20_000);

  it("(f) a non-loopback seam is ignored, not honored: distinct notice, no overlay", async () => {
    const t = makeTestRepo({});
    // .invalid never resolves — but the discriminator is the notice wording:
    // revert-check: drop the loopback guard → the seam is honored, the fetch
    // fails DNS, and stdout says "endpoint unreachable", failing both
    // wording assertions below.
    const r = await login(t, "http://obligato-evil.invalid:9999", [
      "--token",
      "tok-prov12",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("non-loopback test root ignored");
    expect(r.stdout).not.toContain("endpoint unreachable");
    expect(existsSync(join(t.home, ".obligato", "models.json"))).toBe(false);
  }, 20_000);

  it("(g) a page-2 failure discards page-1 accumulation — overlay never written", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++;
        if (calls === 1)
          return Response.json({
            data: [
              {
                id: "claude-page1",
                max_input_tokens: 100_000,
                max_tokens: 8_000,
              },
            ],
            has_more: true,
            last_id: "claude-page1",
          });
        return new Response("boom", { status: 500 });
      },
    });
    const t = makeTestRepo({});
    const r = await login(t, `http://127.0.0.1:${server.port}`, [
      "--key",
      "sk-prov12",
    ]);
    expect(r.exitCode).toBe(0);
    expect(calls).toBe(2);
    // revert-check: write entries page-by-page (writeOverlay inside the loop)
    // → models.json exists with claude-page1 and this assertion fails.
    expect(existsSync(join(t.home, ".obligato", "models.json"))).toBe(false);
    expect(r.stdout).toContain("model detection skipped");
    server.stop(true);
  }, 20_000);

  it("(h) has_more without last_id is malformed: notice, overlay absent", async () => {
    const f = detectFixture({
      pages: [
        {
          data: [
            {
              id: "claude-cursorless",
              max_input_tokens: 100_000,
              max_tokens: 8_000,
            },
          ],
          has_more: true,
          // no last_id
        },
      ],
    });
    const t = makeTestRepo({});
    const r = await login(t, f.root, ["--key", "sk-prov12"]);
    expect(r.exitCode).toBe(0);
    // revert-check: restore the old `has_more !== true || last_id` break (which
    // WROTE the accumulated entries) → models.json exists and this fails.
    expect(existsSync(join(t.home, ".obligato", "models.json"))).toBe(false);
    expect(r.stdout).toContain("malformed page");
    f.stop();
  }, 20_000);
});
