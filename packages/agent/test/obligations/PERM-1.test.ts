import { describe, expect, it } from "bun:test";
import type { PermissionRule } from "@obligato/schemas";
import { decide } from "../../src/permissions.ts";

// Expected outcomes enumerated by hand, straight from the divergence probes
// (2026-07-03) plus the deny-trump amendment.
const CASES: {
  name: string;
  rules: PermissionRule[];
  tool: string;
  arg: string;
  expected: "allow" | "ask" | "deny";
}[] = [
  {
    name: "deny-trump: blanket deny beats a more-specific tool-literal allow",
    rules: [
      { tool: "*", arg: "/etc/*", action: "deny" },
      { tool: "read", action: "allow" },
    ],
    tool: "read",
    arg: "/etc/passwd",
    expected: "deny",
  },
  {
    name: "tool dominance among allow/ask: (4,0) beats (0,5)",
    rules: [
      { tool: "*", arg: "/etc/*", action: "ask" },
      { tool: "read", action: "allow" },
    ],
    tool: "read",
    arg: "/etc/passwd",
    expected: "allow",
  },
  {
    name: "arg discriminates at equal tool specificity: (5,3) beats (5,0)",
    rules: [
      { tool: "write", action: "ask" },
      { tool: "write", arg: "*.md", action: "allow" },
    ],
    tool: "write",
    arg: "docs/README.md",
    expected: "allow",
  },
  {
    name: "exact tuple tie resolves ask > allow",
    rules: [
      { tool: "bash", action: "allow" },
      { tool: "bash", action: "ask" },
    ],
    tool: "bash",
    arg: "ls -la",
    expected: "ask",
  },
  {
    name: "list order never decides: reversed tie still resolves ask > allow",
    rules: [
      { tool: "bash", action: "ask" },
      { tool: "bash", action: "allow" },
    ],
    tool: "bash",
    arg: "ls -la",
    expected: "ask",
  },
  {
    name: "flat glob: * crosses / (*.ts matches src/app.ts)",
    rules: [{ tool: "write", arg: "*.ts", action: "allow" }],
    tool: "write",
    arg: "src/app.ts",
    expected: "allow",
  },
  {
    name: "literal counting decides debatable pairs: gr* (2) beats *p (1)",
    rules: [
      { tool: "gr*", action: "ask" },
      { tool: "*p", action: "allow" },
    ],
    tool: "grep",
    arg: "TODO",
    expected: "ask",
  },
  {
    name: "default: read-only tool with no match allows",
    rules: [],
    tool: "read",
    arg: "/etc/passwd",
    expected: "allow",
  },
  {
    name: "default: bash with no match asks regardless of the command",
    rules: [],
    tool: "bash",
    arg: "ls -la",
    expected: "ask",
  },
  {
    name: "default: an unknown tool outside the core set asks",
    rules: [],
    tool: "teleport",
    arg: "anywhere",
    expected: "ask",
  },
  {
    // AGT-19/PERM-1 amendment 2026-07-20: todo default-allows — it mutates
    // only the session's own advisory list, nothing external to guard.
    name: "default: todo with no match allows",
    rules: [],
    tool: "todo",
    arg: "3 items",
    expected: "allow",
  },
  {
    name: "non-matching rule falls through to the default",
    rules: [{ tool: "read", arg: "/secret/*", action: "deny" }],
    tool: "ls",
    arg: "/home",
    expected: "allow",
  },
];

describe("PERM-1: deny trumps; tool-dominant lexicographic specificity; ask > allow ties; defaults", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(decide(c.rules, c.tool, c.arg)).toBe(c.expected);
    });
  }
});
