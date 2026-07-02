import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// TEL-2's strongest form: the kernel and schemas packages contain no network
// path at all — nothing to opt out of. The full-session network-recorder
// integration test lives in packages/cc-plugin/test/obligations/TEL-2.test.ts.
// Process-spawning is exempted ONLY for the sandbox-execution modules: SEC-1
// mandates the eval runner spawn sessions in isolated workspaces, and a
// spawned child is not a telemetry transmission path — network modules stay
// banned in those files too.
const NETWORK_PATTERNS = [
  /from\s+["'](node:)?(https?|http2|net|tls|dgram|dns)["']/,
  /require\(["'](node:)?(https?|http2|net|tls|dgram|dns)["']\)/,
  /from\s+["'](undici|axios|node-fetch|got|ky)["']/,
  /\bfetch\s*\(/,
  /new\s+WebSocket\b/,
  /XMLHttpRequest|sendBeacon/,
  /Bun\.(connect|listen|serve|udpSocket)\b/,
  /["']bun:ffi["']/,
];

const SPAWN_PATTERNS = [/from\s+["'](node:)?child_process["']/, /Bun\.spawn\b/];

const SPAWN_ALLOWED = new Set(["sandbox.ts", "snapshots.ts"]);

// TEL-6 is TEL-2's sanctioned opt-in: otel.ts performs network IO only when
// the caller supplies an endpoint; nothing calls it ambiently. The scan
// exempts exactly that file — everywhere else the ban stands.
const NETWORK_ALLOWED = new Set(["otel.ts"]);

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));

describe("TEL-2: telemetry has no off-machine path unless explicitly opted in", () => {
  it("kernel and schemas sources import no network module and open no socket", () => {
    const root = join(import.meta.dir, "..", "..", "..");
    const files = [
      ...sourceFiles(join(root, "kernel", "src")),
      ...sourceFiles(join(root, "schemas", "src")),
    ];
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (![...NETWORK_ALLOWED].some((f) => file.endsWith(`/${f}`)))
        for (const pattern of NETWORK_PATTERNS)
          expect(src).not.toMatch(pattern);
      if (![...SPAWN_ALLOWED].some((f) => file.endsWith(`/${f}`)))
        for (const pattern of SPAWN_PATTERNS) expect(src).not.toMatch(pattern);
    }
  });
});
