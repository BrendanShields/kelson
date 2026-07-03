import { describe, expect, it } from "bun:test";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..", "..");

// UX-9 obligation (divergence-pinned 2026-07-03): scan set is
// packages/*/src/**/*.ts — ALL workspace packages, kernel included,
// test/ excluded. Allowlist is file-path-keyed. stderr is out of scope.
const ALLOWLIST = new Set([
  "packages/cli/src/components/sink.ts", // the component layer's single sink
  "packages/cli/src/output/json.ts", // --json emitter (UX-1)
  "packages/cli/src/output/stream.ts", // model-delta streamer (UX-15)
  // cc-plugin protocol emitters: stdout is consumed by Claude Code
  "packages/cc-plugin/src/status.ts",
  "packages/cc-plugin/src/statusline.ts",
  "packages/cc-plugin/src/register.ts",
]);

describe("UX-9: all rendered CLI output routes through the §7 component layer", () => {
  it("no console.log/process.stdout.write outside the sink and the allowlist", async () => {
    const glob = new Bun.Glob("packages/*/src/**/*.ts");
    const offenders: string[] = [];
    for await (const file of glob.scan({ cwd: REPO })) {
      const rel = relative(REPO, join(REPO, file));
      if (ALLOWLIST.has(rel)) continue;
      const text = await Bun.file(join(REPO, file)).text();
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        if (/console\.log\(|process\.stdout\.write\(/.test(line))
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
    // print offenders on miss — a silent gate failure is undebuggable
    expect(
      offenders,
      `unlisted stdout write sites:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the scan set is not vacuous (it sees all workspace packages)", async () => {
    const glob = new Bun.Glob("packages/*/src/**/*.ts");
    const pkgs = new Set<string>();
    for await (const file of glob.scan({ cwd: REPO }))
      pkgs.add(file.split("/")[1] as string);
    // kernel included — the divergence-pinned boundary
    expect(pkgs.has("kernel")).toBe(true);
    expect(pkgs.has("cli")).toBe(true);
    expect(pkgs.has("cc-plugin")).toBe(true);
  });
});
