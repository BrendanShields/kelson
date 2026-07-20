import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ExecResult } from "@obligato/kernel";
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

// AGT-4: containment must survive symlink traversal, not just `..`. A prefix
// test on the lexically-resolved path lets a symlink created inside the
// workspace (e.g. `ln -s / link`) point out of it. We realpath the cwd
// baseline and the deepest existing ancestor of the target (write targets may
// not exist yet), re-attach the non-existent tail, and check the *real* path —
// so a link anywhere along the existing prefix that leaves cwd is refused,
// while a symlinked temp root (macOS /tmp -> /private/tmp) does not spuriously
// reject because the baseline is realpath'd too.
const contained = (cwd: string, path: string): string => {
  const realCwd = realpathSync(cwd);
  const abs = resolve(realCwd, path);
  let existing = abs;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    // basename, not slice(parent.length + 1): at the root, parent "/" already
    // ends in the separator, and the slice eats the tail's first character —
    // "/xprivate/…" re-attached as "private/…" was wrongly ACCEPTED as an
    // aliased in-workspace path (audit 2026-07-05).
    tail.unshift(basename(existing));
    existing = parent;
  }
  const real =
    tail.length > 0
      ? join(realpathSync(existing), ...tail)
      : realpathSync(existing);
  if (real !== realCwd && !real.startsWith(realCwd + sep))
    throw new Error(`path escapes the workspace: ${path}`);
  return real;
};

export interface AgentTool {
  name: string;
  description: string;
  params: z.ZodType;
  // The primary argument PERM-1 arg globs match against.
  primaryArg: (input: Record<string, unknown>) => string;
  run: (input: Record<string, unknown>, ctx: ToolContext) => string;
}

// AGT-13: whole-line-window fallback matching for edit. Layer (a) tolerates
// trailing-whitespace drift; layer (b) is a consistent-indentation remap —
// identical `old` leadings must meet identical file leadings (admits
// tab↔space substitution and uniform shifts; refuses inconsistent windows),
// and the replacement's leadings are rewritten through the same map so the
// FILE's indentation vocabulary wins.
const leading = (s: string): string =>
  s.slice(0, s.length - s.trimStart().length);

const findWindows = (
  fileLines: string[],
  oldLines: string[],
  matches: (fileLine: string, oldLine: string) => boolean,
  remap: boolean,
): { start: number; leadMap: Map<string, string> | null }[] => {
  const out: { start: number; leadMap: Map<string, string> | null }[] = [];
  outer: for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    const leadMap = remap ? new Map<string, string>() : null;
    for (let j = 0; j < oldLines.length; j++) {
      const fl = fileLines[i + j] as string;
      const ol = oldLines[j] as string;
      if (!matches(fl, ol)) continue outer;
      if (leadMap && ol.trim().length > 0) {
        const oLead = leading(ol);
        const fLead = leading(fl);
        const known = leadMap.get(oLead);
        if (known !== undefined && known !== fLead) continue outer;
        leadMap.set(oLead, fLead);
      }
    }
    // non-overlapping: skip windows overlapping the previous accepted one
    const prev = out[out.length - 1];
    if (prev && i < prev.start + oldLines.length) continue;
    out.push({ start: i, leadMap });
  }
  return out;
};

const applyLeadMap = (
  line: string,
  leadMap: Map<string, string> | null,
): string => {
  if (leadMap === null || line.trim().length === 0) return line;
  const lead = leading(line);
  const mapped = leadMap.get(lead);
  return mapped === undefined ? line : mapped + line.slice(lead.length);
};

const shellQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;

// AGT-14: capped output must say so — never truncate silently. The cap lives
// entirely in JS: an in-shell `| head` would swallow the search's exit code
// (pipeline status = head's), turning an invalid-regex error into a silent
// "(no matches)" (audit 2026-07-05). Caps are measured in characters.
const OUTPUT_LINE_CAP = 200;
const OUTPUT_CHAR_CAP = 60_000;
const capNotice = (out: string): string => {
  let text = out;
  let capped = false;
  const lines = text.split("\n");
  if (lines.filter((l) => l.length > 0).length > OUTPUT_LINE_CAP) {
    text = lines.slice(0, OUTPUT_LINE_CAP).join("\n");
    capped = true;
  }
  if (text.length > OUTPUT_CHAR_CAP) {
    text = text.slice(0, OUTPUT_CHAR_CAP);
    capped = true;
  }
  return capped
    ? `${text.trimEnd()}\n(capped at ${OUTPUT_LINE_CAP} lines / ${OUTPUT_CHAR_CAP} characters — refine the query)`
    : text;
};

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
      const path = String(i.path);
      // Layer order: exact first — byte-identical replace, mid-line capable.
      const count = text.split(old).length - 1;
      if (count > 0) {
        if (count > 1 && i.all !== true)
          throw new Error(
            `old string occurs ${count} times in ${path} — pass all=true or a longer unique string`,
          );
        writeFileSync(abs, text.split(old).join(String(i.new)));
        return `replaced ${i.all === true ? count : 1} occurrence(s) in ${path}`;
      }
      // AGT-13 tolerant layers: whole-line windows only.
      const fileLines = text.split("\n");
      const oldLines = old.split("\n");
      const newLines = String(i.new).split("\n");
      const layers: {
        name: string;
        windows: { start: number; leadMap: Map<string, string> | null }[];
      }[] = [
        {
          name: "trailing-whitespace-insensitive",
          windows: findWindows(
            fileLines,
            oldLines,
            (f, o) => f.trimEnd() === o.trimEnd(),
            false,
          ),
        },
        {
          name: "consistent-indentation-remap",
          windows: findWindows(
            fileLines,
            oldLines,
            (f, o) => f.trim() === o.trim(),
            true,
          ),
        },
      ];
      for (const layer of layers) {
        if (layer.windows.length === 0) continue;
        if (layer.windows.length > 1 && i.all !== true)
          throw new Error(
            `old block matches ${layer.windows.length} windows in ${path} (${layer.name}) — pass all=true or a longer unique block`,
          );
        // splice back-to-front so earlier starts stay valid
        for (const w of [...layer.windows].reverse())
          fileLines.splice(
            w.start,
            oldLines.length,
            ...newLines.map((l) => applyLeadMap(l, w.leadMap)),
          );
        writeFileSync(abs, fileLines.join("\n"));
        return `replaced ${layer.windows.length} occurrence(s) in ${path} (${layer.name} match)`;
      }
      // AGT-13: near-miss excerpt so the model self-corrects without re-read.
      const firstOld = (oldLines[0] as string).trim();
      const anchor =
        firstOld.length > 0
          ? fileLines.findIndex((l) => l.trim() === firstOld)
          : -1;
      const nearMiss =
        anchor >= 0
          ? `\nclosest match near line ${anchor + 1}:\n${fileLines
              .slice(Math.max(0, anchor - 1), anchor + oldLines.length + 1)
              .join("\n")}`
          : "";
      throw new Error(`old string not found in ${path}${nearMiss}`);
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
      "Search file contents with a regex. Uses ripgrep when available (.gitignore-aware; optional glob filter), else grep -rn. Returns file:line-prefixed matches, capped at 200 lines.",
    params: z.object({
      pattern: z.string().min(1),
      path: z.string().optional(),
      glob: z.string().optional(),
    }),
    primaryArg: (i) => String(i.pattern),
    run: (i, ctx) => {
      const pat = shellQuote(String(i.pattern));
      const path = shellQuote(String(i.path ?? "."));
      const glob =
        i.glob !== undefined ? `-g ${shellQuote(String(i.glob))} ` : "";
      // AGT-14: the availability branch rides inside the one shell call, so
      // every sandbox resolves rg for its own filesystem; both branches cap
      // at 200 lines in-shell.
      // The fallback notice is emitted by the shell branch itself — one exec.
      const globNote =
        i.glob !== undefined
          ? `echo '(glob filter ignored: ripgrep not available)'; `
          : "";
      const r = ctx.exec(
        `if command -v rg >/dev/null 2>&1; then rg -n --no-heading -H ${glob}-e ${pat} ${path}; else ${globNote}grep -rn --exclude-dir=.git --exclude-dir=node_modules -e ${pat} ${path}; fi`,
      );
      // grep/rg exit 1 on no matches — that is a result, not an error.
      if (r.exitCode > 1) return `exit ${r.exitCode}\n${r.stderr}`;
      return capNotice(r.stdout) || "(no matches)";
    },
  },
  {
    name: "find",
    description:
      "Find files by name glob. Uses ripgrep --files when available (.gitignore-aware), else find -name pruning .git and node_modules. Capped at 200 lines.",
    params: z.object({
      pattern: z.string().min(1),
      path: z.string().optional(),
    }),
    primaryArg: (i) => String(i.pattern),
    run: (i, ctx) => {
      const pat = shellQuote(String(i.pattern));
      const path = shellQuote(String(i.path ?? "."));
      const r = ctx.exec(
        `if command -v rg >/dev/null 2>&1; then rg --files -g ${pat} ${path}; else find ${path} \\( -name .git -o -name node_modules \\) -prune -o -name ${pat} -print; fi`,
      );
      if (r.exitCode > 1) return `exit ${r.exitCode}\n${r.stderr}`;
      return capNotice(r.stdout) || "(no matches)";
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
  {
    // AGT-19: advisory session task list — each call replaces the whole list.
    // The output serialization is a contract: UX-36's chat reducer parses it.
    name: "todo",
    description:
      "Maintain your task list for the operator. Send the FULL list every call (it replaces the previous one): items with text and state pending|active|done. Update it when you start or finish a task.",
    params: z.object({
      items: z.array(
        z.object({
          // Newline-free: the serialization is line-delimited — an embedded
          // \n would forge extra lines in the UX-36 parser (audit 2026-07-20).
          text: z
            .string()
            .min(1)
            .refine((t) => !t.includes("\n"), "text must be a single line"),
          state: z.enum(["pending", "active", "done"]),
        }),
      ),
    }),
    primaryArg: (i) => `${(i.items as unknown[]).length} items`,
    run: (i) => {
      const items = i.items as { text: string; state: string }[];
      if (items.length === 0) return "(no tasks)";
      const marker = { pending: "[ ]", active: "[>]", done: "[x]" } as const;
      return items
        .map((t) => `${marker[t.state as keyof typeof marker]} ${t.text}`)
        .join("\n");
    },
  },
];
