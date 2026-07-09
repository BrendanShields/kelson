import { afterAll, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiServer } from "../../src/ui/server.ts";

// macOS: /tmp is a symlink to /private/tmp — realpath the base so the
// containment under test compares against a non-symlinked root.
const base = realpathSync(mkdtempSync(join(tmpdir(), "kelson-sec7-")));
const SENTINEL = "SEC7-OUTSIDE-SENTINEL-must-never-be-served";

const staticDir = join(base, "dist");
mkdirSync(staticDir);
writeFileSync(join(staticDir, "index.html"), "sec7 index shell");
writeFileSync(join(staticDir, "app.js"), "sec7 legit asset body");

// outside-the-root sentinel targets
writeFileSync(join(base, "secret.txt"), SENTINEL);
mkdirSync(join(base, "dist2")); // sibling sharing the root's name as a prefix
writeFileSync(join(base, "dist2", "leak.txt"), SENTINEL);
symlinkSync(join(base, "secret.txt"), join(staticDir, "escape.txt"));

const server = createUiServer({
  dbPath: join(base, "k.db"),
  staticDir,
  port: 0,
});
afterAll(() => server.stop(true));

const get = (target: string) =>
  fetch(`http://127.0.0.1:${server.port}${target}`);

// fetch()'s URL parser strips literal dot segments, so raw request-target
// bytes go over a plain socket to exercise the server's own handling.
const rawGet = (target: string): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    Bun.connect({
      hostname: "127.0.0.1",
      port: Number(server.port),
      socket: {
        open(s) {
          s.write(
            `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
          );
        },
        data(_s, d) {
          chunks.push(Buffer.from(d));
        },
        close() {
          resolve(Buffer.concat(chunks).toString());
        },
        error() {
          resolve(Buffer.concat(chunks).toString());
        },
      },
    });
  });

describe("SEC-7: static assets serve only from inside the realpath-resolved root, by segment boundary", () => {
  it("dot-dot traversal (../-style and %2e%2e-encoded) returns 404 without the target's content", async () => {
    // encoded-slash forms survive URL dot-segment normalization and reach
    // the server intact — these are the requests the guard must judge
    const targets = [
      "/..%2fsecret.txt", // ../-style, slash encoded
      "/%2e%2e%2fsecret.txt", // fully %2e%2e-encoded
      "/a/..%2f..%2fsecret.txt", // nested climb-out
    ];
    for (const target of targets) {
      const res = await get(target);
      const body = await res.text();
      expect(`${target} ${res.status}`).toBe(`${target} 404`);
      expect(body).not.toContain(SENTINEL);
    }
  });

  it("raw literal /../ request-targets never leak the target (runtime clamps dot segments before the handler)", async () => {
    for (const target of ["/../secret.txt", "/%2e%2e/secret.txt"]) {
      const response = await rawGet(target);
      expect(response).not.toContain(SENTINEL);
    }
  });

  it("a sibling dir sharing the root name prefix (dist2) is refused where prefix comparison would serve it", async () => {
    // resolves to <base>/dist2/leak.txt, which startsWith(<base>/dist) — the
    // old string-prefix guard admits it; segment-boundary containment must not
    const res = await get("/..%2fdist2%2fleak.txt");
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(body).not.toContain(SENTINEL);
  });

  it("a symlink inside the root pointing outside returns 404 without reading the target", async () => {
    const res = await get("/escape.txt");
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(body).not.toContain(SENTINEL);
  });

  it("a legitimate asset still serves 200 with its content", async () => {
    const res = await get("/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("sec7 legit asset body");
  });

  it("SPA client-route fallback to index.html is preserved for contained-but-missing paths", async () => {
    const res = await get("/some/client/route");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("sec7 index shell");
  });
});
