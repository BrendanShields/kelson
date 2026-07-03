import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { ExecResult } from "@kelson/kernel";
import { z } from "zod";

// AGT-4: all filesystem/process access flows through the caller-supplied
// context — chat passes the repo dir + local exec, eval runs pass the
// sandbox workspace's dir + exec, so isolation composes with zero code here.
export interface ToolContext {
  cwd: string;
  exec: (
    command: string,
    opts?: { env?: Record<string, string>; timeoutMs?: number },
  ) => ExecResult;
}

export const localExec =
  (cwd: string): ToolContext["exec"] =>
  (command, opts) => {
    const r = spawnSync("sh", ["-c", command], {
      cwd,
      encoding: "utf8",
      timeout: opts?.timeoutMs ?? 120_000,
      env: { ...process.env, ...opts?.env },
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      exitCode: r.status ?? 1,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      timedOut: r.signal === "SIGTERM",
    };
  };

const contained = (cwd: string, path: string): string => {
  const abs = resolve(cwd, path);
  if (abs !== cwd && !abs.startsWith(cwd + sep))
    throw new Error(`path escapes the workspace: ${path}`);
  return abs;
};

export interface AgentTool {
  name: string;
  description: string;
  params: z.ZodType;
  // The primary argument PERM-1 arg globs match against.
  primaryArg: (input: Record<string, unknown>) => string;
  run: (input: Record<string, unknown>, ctx: ToolContext) => string;
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

export const CORE_TOOLS: AgentTool[] = [
  {
    name: "read",
    description:
      "Read a file. Returns the full text, or a slice when offset/limit are given (1-based line offset).",
    params: z.object({
      path: z.string(),
      offset: z.number().int().positive().optional(),
      limit: z.number().int().positive().optional(),
    }),
    primaryArg: (i) => String(i.path),
    run: (i, ctx) => {
      const text = readFileSync(contained(ctx.cwd, String(i.path)), "utf8");
      if (i.offset === undefined && i.limit === undefined) return text;
      const lines = text.split("\n");
      const start = ((i.offset as number | undefined) ?? 1) - 1;
      const count = (i.limit as number | undefined) ?? lines.length;
      return lines.slice(start, start + count).join("\n");
    },
  },
  {
    name: "write",
    description:
      "Write a file, creating parent directories and overwriting any existing content.",
    params: z.object({ path: z.string(), content: z.string() }),
    primaryArg: (i) => String(i.path),
    run: (i, ctx) => {
      const abs = contained(ctx.cwd, String(i.path));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, String(i.content));
      return `wrote ${String(i.path)}`;
    },
  },
  {
    name: "edit",
    description:
      "Replace text in a file. old must occur exactly once unless all=true (repo rule: occurrence count is asserted, a silent partial match is an error).",
    params: z.object({
      path: z.string(),
      old: z.string().min(1),
      new: z.string(),
      all: z.boolean().optional(),
    }),
    primaryArg: (i) => String(i.path),
    run: (i, ctx) => {
      const abs = contained(ctx.cwd, String(i.path));
      const text = readFileSync(abs, "utf8");
      const old = String(i.old);
      const count = text.split(old).length - 1;
      if (count === 0)
        throw new Error(`old string not found in ${String(i.path)}`);
      if (count > 1 && i.all !== true)
        throw new Error(
          `old string occurs ${count} times in ${String(i.path)} — pass all=true or a longer unique string`,
        );
      writeFileSync(abs, text.split(old).join(String(i.new)));
      return `replaced ${i.all === true ? count : 1} occurrence(s) in ${String(i.path)}`;
    },
  },
  {
    name: "bash",
    description:
      "Run a shell command in the workspace. Returns stdout, stderr, and the exit code.",
    params: z.object({
      command: z.string().min(1),
      timeout_ms: z.number().int().positive().optional(),
    }),
    primaryArg: (i) => String(i.command),
    run: (i, ctx) => {
      const r = ctx.exec(String(i.command), {
        ...(i.timeout_ms !== undefined
          ? { timeoutMs: Number(i.timeout_ms) }
          : {}),
      });
      const out = [r.stdout, r.stderr && `stderr: ${r.stderr}`]
        .filter(Boolean)
        .join("\n");
      if (r.timedOut) return `timed out\n${out}`;
      return r.exitCode === 0
        ? out || "(no output)"
        : `exit ${r.exitCode}\n${out}`;
    },
  },
  {
    name: "grep",
    description:
      "Search file contents with a regex (grep -rn). Returns matching lines with file:line prefixes.",
    params: z.object({
      pattern: z.string().min(1),
      path: z.string().optional(),
    }),
    primaryArg: (i) => String(i.pattern),
    run: (i, ctx) => {
      const r = ctx.exec(
        `grep -rn --exclude-dir=.git --exclude-dir=node_modules -e ${shellQuote(String(i.pattern))} ${shellQuote(String(i.path ?? "."))}`,
      );
      // grep exits 1 on no matches — that is a result, not an error.
      if (r.exitCode > 1) return `exit ${r.exitCode}\n${r.stderr}`;
      return r.stdout || "(no matches)";
    },
  },
  {
    name: "find",
    description:
      "Find files by name glob (find -name), pruning .git and node_modules.",
    params: z.object({
      pattern: z.string().min(1),
      path: z.string().optional(),
    }),
    primaryArg: (i) => String(i.pattern),
    run: (i, ctx) => {
      const r = ctx.exec(
        `find ${shellQuote(String(i.path ?? "."))} \\( -name .git -o -name node_modules \\) -prune -o -name ${shellQuote(String(i.pattern))} -print`,
      );
      if (r.exitCode !== 0) return `exit ${r.exitCode}\n${r.stderr}`;
      return r.stdout || "(no matches)";
    },
  },
  {
    name: "ls",
    description:
      "List a directory (entries suffixed with / for subdirectories).",
    params: z.object({ path: z.string().optional() }),
    primaryArg: (i) => String(i.path ?? "."),
    run: (i, ctx) => {
      const abs = contained(ctx.cwd, String(i.path ?? "."));
      return (
        readdirSync(abs, { withFileTypes: true })
          .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
          .join("\n") || "(empty)"
      );
    },
  },
];
