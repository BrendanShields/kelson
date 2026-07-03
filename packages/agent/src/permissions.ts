import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type PermissionAction, PermissionRule } from "@kelson/schemas";
import { z } from "zod";

const READ_ONLY = new Set(["read", "grep", "find", "ls"]);

// ponytail: JSON, not YAML — no YAML dependency for a rules list.
export const loadRules = (repoRoot: string): PermissionRule[] => {
  const path = join(repoRoot, ".kelson", "permissions.json");
  if (!existsSync(path)) return [];
  return z.array(PermissionRule).parse(JSON.parse(readFileSync(path, "utf8")));
};

// PERM-1: flat globs — * crosses "/", ? is any single char.
const globToRegExp = (glob: string): RegExp => {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[\\s\\S]*")
    .replace(/\?/g, "[\\s\\S]");
  return new RegExp(`^${escaped}$`);
};

const matches = (glob: string, value: string): boolean =>
  globToRegExp(glob).test(value);

const literalChars = (glob: string | undefined): number =>
  glob === undefined ? 0 : glob.replace(/[*?]/g, "").length;

// PERM-1 (divergence ruling 2026-07-03): deny trumps regardless of
// specificity; among the rest, lexicographic (literalChars(tool),
// literalChars(arg)) with tool dominant; exact ties resolve ask > allow;
// list order never decides between different actions.
export const decide = (
  rules: PermissionRule[],
  tool: string,
  arg: string,
): PermissionAction => {
  const matching = rules.filter(
    (r) =>
      matches(r.tool, tool) && (r.arg === undefined || matches(r.arg, arg)),
  );
  if (matching.some((r) => r.action === "deny")) return "deny";

  let best: PermissionRule | undefined;
  for (const r of matching) {
    if (!best) {
      best = r;
      continue;
    }
    const cmp =
      literalChars(r.tool) - literalChars(best.tool) ||
      literalChars(r.arg) - literalChars(best.arg);
    if (cmp > 0 || (cmp === 0 && r.action === "ask" && best.action === "allow"))
      best = r;
  }
  if (best) return best.action;
  return READ_ONLY.has(tool) ? "allow" : "ask";
};
