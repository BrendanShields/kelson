import {
  buildSessionTree,
  compactSession,
  compareBranches,
  currentHead,
  forkSession,
  listEvents,
  promoteSession,
} from "@obligato/agent";
import { DEFAULT_DB_PATH, openDb } from "@obligato/kernel";
import { SessionTreeNode } from "@obligato/schemas";
import { z } from "zod";
import { parseArgs } from "../args.js";
import { treeDepth } from "../chat/view.js";
import { write } from "../components/sink.js";
import { emitJson } from "../output/json.js";
import { fail } from "./common.js";

const openStore = (dbPath?: string) =>
  openDb(typeof dbPath === "string" ? dbPath : DEFAULT_DB_PATH);

// SES-6/7/8: `obligato session fork|compare|compact`.
export const sessionCommand = (argv: string[]): void => {
  const [sub, ...rest] = argv;
  const { positional, named } = parseArgs(rest);
  const db = openStore(named.db as string | undefined);

  if (sub === "tree") {
    const sid =
      positional[0] ?? fail("usage: obligato session tree <session> [--json]");
    // UX-34: same builder as the chat rail pane (F-085 — one function).
    const events = listEvents(db, sid as string);
    const nodes = buildSessionTree(events, currentHead(events));
    if (named.json === true) {
      emitJson(z.array(SessionTreeNode).parse(nodes));
      return;
    }
    for (const n of nodes)
      write(`${"  ".repeat(treeDepth(nodes, n))}${n.label}`);
    return;
  }

  if (sub === "fork") {
    const sid =
      positional[0] ??
      fail("usage: obligato session fork <session> [event-id]");
    const { forkHead, originalHead } = forkSession(
      db,
      sid as string,
      positional[1],
    );
    write(`forked ${sid}`);
    write(`  fork head:     ${forkHead}`);
    write(`  original head: ${originalHead}`);
    return;
  }

  if (sub === "compare") {
    const sid = positional[0];
    const headA = positional[1];
    const headB = positional[2];
    if (!sid || !headA || !headB)
      fail("usage: obligato session compare <session> <headA> <headB>");
    const cmp = compareBranches(
      db,
      sid as string,
      headA as string,
      headB as string,
    );
    write(`common ancestor: ${cmp.common_ancestor ?? "(none)"}`);
    write(`shared prefix:   ${cmp.shared_prefix} events`);
    write(
      `A: ${cmp.a.cost_micro_usd} µUSD, ${cmp.a.event_count} events, ${cmp.a.lifecycle} — "${cmp.a.last_text.slice(0, 60)}"`,
    );
    write(
      `B: ${cmp.b.cost_micro_usd} µUSD, ${cmp.b.event_count} events, ${cmp.b.lifecycle} — "${cmp.b.last_text.slice(0, 60)}"`,
    );
    return;
  }

  if (sub === "compact") {
    const sid =
      positional[0] ?? fail("usage: obligato session compact <session>");
    // A single-line naive summarizer; the loop uses a cheap routed model.
    const range = compactSession(
      db,
      sid as string,
      (chain) =>
        `Summary of ${chain.length} prior events (compacted ${new Date().toISOString()}).`,
    );
    write(`compacted ${sid}: [${range.from_event} … ${range.to_event}]`);
    return;
  }

  fail(
    `unknown session subcommand: ${sub ?? "(none)"} (have: tree, fork, compare, compact)`,
  );
};

// EVP-10: `obligato promote <session> --suite <staging-dir>`.
export const promoteCommand = (argv: string[]): void => {
  const { positional, named } = parseArgs(argv);
  const sid =
    positional[0] ??
    fail("usage: obligato promote <session> --suite <staging-dir>");
  const suite =
    (named.suite as string) ??
    fail("usage: obligato promote <session> --suite <staging-dir>");
  const db = openStore(named.db as string | undefined);
  const task = promoteSession(db, sid as string, suite);
  write(`promoted ${sid} → ${task.id}`);
  write(`  statement: ${task.statement.slice(0, 70)}`);
  write(`  snapshot:  ${task.snapshot}`);
  write(`  budget:    ${task.budget_ceiling_musd} µUSD`);
  write(`  checks:    ${task.checks.map((c) => c.kind).join(", ")}`);
  write(
    `  → replay with: obligato eval ablate --suite ${suite} --executor api`,
  );
};
