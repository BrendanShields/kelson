import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeTestRepo, runCli, type TestRepo } from "../agent-helpers.ts";

interface Probe {
  auth: string | null;
  path: string;
}

const modelsFixture = (
  opts: { status?: number; body?: unknown; noRoute?: boolean } = {},
) => {
  const seen: Probe[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      seen.push({ auth: req.headers.get("authorization"), path: url.pathname });
      if (opts.noRoute || url.pathname !== "/v1/models")
        return new Response("no such route", { status: 404 });
      return Response.json(
        opts.body ?? { data: [{ id: "m1" }, { id: "m2" }] },
        { status: opts.status ?? 200 },
      );
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    seen,
    stop: () => server.stop(true),
  };
};

const login = (t: TestRepo, baseUrl: string, extra: string[] = []) =>
  runCli(t, [
    "auth",
    "login",
    "openai-compatible",
    "--base-url",
    baseUrl,
    "--model",
    "m1",
    ...extra,
  ]);

const persisted = (t: TestRepo) => ({
  overlay: existsSync(join(t.home, ".obligato", "models.json")),
  auth: existsSync(join(t.home, ".obligato", "auth.json")),
  config: existsSync(join(t.repo, ".obligato", "config.json")),
});

const expectNothingPersisted = (t: TestRepo) => {
  expect(persisted(t)).toEqual({ overlay: false, auth: false, config: false });
};

describe("PROV-11: openai-compatible login probes /models and persists atomically-ordered state", () => {
  it("(a) keyed success: overlay + 0600 credential + config; server saw the Bearer value; key never echoed", async () => {
    const SECRET = "sk-prov11-XYZZY";
    const f = modelsFixture();
    const t = makeTestRepo({});
    // Fresh-HOME discipline: the helper pre-creates ~/.obligato, which masked
    // a writeOverlay ENOENT on never-configured machines (E2E catch) — remove
    // it so this case proves the login creates its own state dir.
    rmSync(join(t.home, ".obligato"), { recursive: true, force: true });
    // Trailing slash: stored verbatim minus the single trailing slash.
    const r = await login(t, `${f.url}/`, ["--key", SECRET]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain(SECRET);
    expect(r.stderr).not.toContain(SECRET);

    const overlay = JSON.parse(
      readFileSync(join(t.home, ".obligato", "models.json"), "utf8"),
    ) as {
      id: string;
      base_url: string;
      prices: unknown;
      context_window: number;
      max_output: number;
    }[];
    expect(overlay).toHaveLength(1);
    expect(overlay[0]?.id).toBe("m1");
    expect(overlay[0]?.base_url).toBe(f.url);
    expect(overlay[0]?.prices).toBeNull();
    expect(overlay[0]?.context_window).toBe(128_000);
    expect(overlay[0]?.max_output).toBe(16_384);

    const authPath = join(t.home, ".obligato", "auth.json");
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
    const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<
      string,
      { type: string; key: string }
    >;
    expect(auth.m1).toEqual({ type: "api_key", key: SECRET });

    const config = JSON.parse(
      readFileSync(join(t.repo, ".obligato", "config.json"), "utf8"),
    ) as { default_model: string };
    expect(config.default_model).toBe("m1");

    // F-119 rule: assert what the server saw, not the code branch.
    const probe = f.seen.find((s) => s.path === "/v1/models");
    expect(probe?.auth).toBe(`Bearer ${SECRET}`);
    f.stop();
  }, 20_000);

  it("(b) model absent from the list — and a data:[] list — exits non-zero persisting nothing", async () => {
    const absent = modelsFixture({ body: { data: [{ id: "other" }] } });
    const t1 = makeTestRepo({});
    const r1 = await login(t1, absent.url, ["--key", "k"]);
    expect(r1.exitCode).not.toBe(0);
    expectNothingPersisted(t1);
    absent.stop();

    const empty = modelsFixture({ body: { data: [] } });
    const t2 = makeTestRepo({});
    const r2 = await login(t2, empty.url, ["--key", "k"]);
    expect(r2.exitCode).not.toBe(0);
    expectNothingPersisted(t2);
    empty.stop();
  }, 20_000);

  it("(c) 401 with a valid-looking list body still fails, persisting nothing", async () => {
    const f = modelsFixture({ status: 401, body: { data: [{ id: "m1" }] } });
    const t = makeTestRepo({});
    const r = await login(t, f.url, ["--key", "bad"]);
    expect(r.exitCode).not.toBe(0);
    expectNothingPersisted(t);
    f.stop();
  }, 20_000);

  it("(d) endpoint without /models: succeeds with the skipped-check note", async () => {
    const f = modelsFixture({ noRoute: true });
    const t = makeTestRepo({});
    const r = await login(t, f.url, ["--key", "k"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("skipping model check");
    expect(persisted(t)).toEqual({ overlay: true, auth: true, config: true });
    f.stop();
  }, 20_000);

  it("(e) keyless login: probe carries no Authorization header; auth file gains no entry", async () => {
    const f = modelsFixture();
    const t = makeTestRepo({});
    const r = await login(t, f.url);
    expect(r.exitCode).toBe(0);
    const probe = f.seen.find((s) => s.path === "/v1/models");
    expect(probe).toBeDefined();
    expect(probe?.auth).toBeNull();
    expect(existsSync(join(t.home, ".obligato", "auth.json"))).toBe(false);
    expect(persisted(t).overlay).toBe(true);
    f.stop();
  }, 20_000);

  it("(f) any other status (500 — and 206, a 2xx-not-200) fails closed, persisting nothing", async () => {
    for (const status of [500, 206]) {
      const f = modelsFixture({ status, body: { data: [{ id: "m1" }] } });
      const t = makeTestRepo({});
      const r = await login(t, f.url, ["--key", "k"]);
      expect(r.exitCode).not.toBe(0);
      expectNothingPersisted(t);
      f.stop();
    }
  }, 20_000);

  it("(g) env-sourced key rides the probe and persists; an explicit empty --key falls through to it", async () => {
    const ENV_KEY = "sk-env-PROV11";
    // Both obligation sub-scenarios: no --key at all, and --key "".
    for (const extra of [[], ["--key", ""]]) {
      const f = modelsFixture();
      const t = makeTestRepo({});
      t.env.OPENAI_API_KEY = ENV_KEY;
      const r = await login(t, f.url, extra);
      expect(r.exitCode).toBe(0);
      const probe = f.seen.find((s) => s.path === "/v1/models");
      expect(probe?.auth).toBe(`Bearer ${ENV_KEY}`);
      const auth = JSON.parse(
        readFileSync(join(t.home, ".obligato", "auth.json"), "utf8"),
      ) as Record<string, { type: string; key: string }>;
      expect(auth.m1).toEqual({ type: "api_key", key: ENV_KEY });
      f.stop();
    }
  }, 20_000);

  it("(h) re-login for the same model id upserts one overlay entry with the new fields", async () => {
    const f = modelsFixture();
    const t = makeTestRepo({});
    const r1 = await login(t, f.url, ["--key", "k"]);
    expect(r1.exitCode).toBe(0);
    const r2 = await login(t, f.url, ["--key", "k", "--context", "32000"]);
    expect(r2.exitCode).toBe(0);
    const overlay = JSON.parse(
      readFileSync(join(t.home, ".obligato", "models.json"), "utf8"),
    ) as { id: string; context_window: number }[];
    expect(overlay).toHaveLength(1);
    expect(overlay[0]?.context_window).toBe(32_000);
    f.stop();
  }, 20_000);
});
