#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyProposal,
  bumpSatisfies,
  compileProposals,
  createProposal,
  DEFAULT_DB_PATH,
  enterGate,
  evaluateGate,
  extractFeatures,
  getProposal,
  loadPack,
  loadPolicy,
  loadRegistry,
  loadSuite,
  matchAgent,
  openDb,
  openMonitor,
  promoteTask,
  readChangelog,
  releaseQuarantined,
  requiredBump,
  resolveRule,
  revertProposal,
  runEval,
  togglePack,
  transition,
  validatePolicyTargets,
  writeLedgerEntry,
} from "@kelson/kernel";
import {
  type Executor,
  Lockfile,
  SandboxProfile,
  type Verdict,
} from "@kelson/schemas";
import { kvGrid, panel, table } from "./components/render.js";
import { write } from "./components/sink.js";
import { emitJson } from "./output/json.js";
import { uiCommand } from "./ui/server.js";
import type { DispatchTable } from "./wizards.js";

interface Flags {
  positional: string[];
  named: Record<string, string | true>;
}

const parseArgs = (argv: string[]): Flags => {
  const positional: string[] = [];
  const named: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        named[key] = next;
        i++;
      } else named[key] = true;
    } else positional.push(a);
  }
  return { positional, named };
};

const die = (msg: string): never => {
  console.error(`kelson: ${msg}`);
  process.exit(1);
};

const str = (v: string | true | undefined, fallback: string): string =>
  typeof v === "string" ? v : fallback;

const loadLockfile = (path: string): Lockfile => {
  try {
    return Lockfile.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    return die(`cannot load lockfile ${path}: ${(e as Error).message}`);
  }
};

// UX J3: verdict is never a bare pass/fail — decision + effect sizes + CIs,
// and underpowered states its deficit (UX-P5).
const renderVerdict = (v: Verdict, minSample = 20): string => {
  const delta = (d: Verdict["fpar_delta"], unit: string) =>
    `${d.mean >= 0 ? "+" : ""}${d.mean.toFixed(3)}${unit} [${d.ci95[0].toFixed(3)}, ${d.ci95[1].toFixed(3)}]`;
  const lines = [
    `verdict: ${v.decision}`,
    `  fpar delta:  ${delta(v.fpar_delta, "")}`,
    `  cost delta:  ${delta(v.cost_delta_pct, "%")}`,
    `  n=${v.n} alpha=${v.alpha} B=${v.bootstrap_resamples}`,
  ];
  if (v.decision === "underpowered")
    lines.push(
      `  underpowered: ${Math.max(0, minSample - v.n)} more paired tasks needed for a powered verdict`,
    );
  if (v.quarantined_tasks.length)
    lines.push(`  quarantined: ${v.quarantined_tasks.join(", ")}`);
  return lines.join("\n");
};

const evalCommand = (argv: string[]): void => {
  const sub = argv[0];
  const { positional, named } = parseArgs(argv.slice(1));
  const dbPath = str(named.db, DEFAULT_DB_PATH);
  const json = named.json === true;

  if (sub === "ablate" || sub === "compare") {
    const suiteDir =
      typeof named.suite === "string"
        ? named.suite
        : die("--suite <dir> is required");
    const executor = str(named.executor, "claude") as Executor;
    if (executor !== "claude" && executor !== "command")
      die(`unknown executor: ${executor}`);
    const isolation = str(named.profile, "worktree");
    const profile = SandboxProfile.parse({
      isolation,
      network:
        isolation === "container"
          ? { policy: "deny", allowlist: [] }
          : { policy: "inherit" },
    });
    if (
      typeof named["base-url"] === "string" &&
      typeof named.model !== "string"
    )
      die(
        "--base-url requires --model (an endpoint without a model would run real-spend sessions)",
      );
    let lockfileA: Lockfile;
    let lockfileB: Lockfile;
    if (sub === "ablate") {
      const pack =
        positional[0] ?? die("usage: kelson eval ablate <pack> --suite <dir>");
      lockfileA = loadLockfile(
        str(named.lockfile, join(process.cwd(), "kelson.lock")),
      );
      lockfileB = togglePack(lockfileA, pack as string);
    } else {
      const [a, b] = positional;
      if (!a || !b)
        die("usage: kelson eval compare <lockA> <lockB> --suite <dir>");
      lockfileA = loadLockfile(a as string);
      lockfileB = loadLockfile(b as string);
    }
    const db = openDb(dbPath);
    try {
      const result = runEval(db, {
        kind: sub,
        suiteDir,
        lockfileA,
        lockfileB,
        executor,
        profile,
        ...(typeof named.seed === "string" ? { seed: Number(named.seed) } : {}),
        ...(typeof named.repeats === "string"
          ? { repeats: Number(named.repeats) }
          : {}),
        ...(typeof named.snapshots === "string"
          ? { snapshotStoreDir: named.snapshots }
          : {}),
        ...(typeof named["routing-pack"] === "string"
          ? {
              routing: {
                pack: named["routing-pack"],
                policyPath: str(
                  named.policy,
                  join(
                    process.cwd(),
                    "packs/routing-default/routing/policy.yaml",
                  ),
                ),
                registryDir: str(
                  named.registry,
                  join(process.cwd(), "packs/routing-default/agents"),
                ),
              },
            }
          : {}),
        ...(typeof named.model === "string"
          ? {
              sessionModel: {
                model: named.model,
                ...(typeof named["base-url"] === "string"
                  ? { baseUrl: named["base-url"] }
                  : {}),
              },
            }
          : {}),
      });
      if (json) emitJson(result);
      else {
        write(`run ${result.runId} manifest ${result.manifestHash}`);
        for (const q of result.quarantine)
          write(
            `quarantined ${q.task_id} (window ${q.window.map((w) => (w ? "P" : "F")).join("")})`,
          );
        write(renderVerdict(result.verdict));
      }
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "suite" && argv[1] === "promote") {
    const { positional: p, named: n } = parseArgs(argv.slice(2));
    const suiteDir =
      typeof n.suite === "string" ? n.suite : die("--suite <dir> is required");
    const taskId =
      p[0] ?? die("usage: kelson eval suite promote <task-id> --suite <dir>");
    const { suite } = loadSuite(suiteDir);
    const db = openDb(str(n.db, DEFAULT_DB_PATH));
    promoteTask(db, suite.id, suite.version, taskId as string);
    write(`re-admitted ${taskId} to ${suite.id}@${suite.version}`);
    db.close();
    return;
  }

  if (sub === "publish") {
    const [runId, pack, version] = positional;
    if (!runId || !pack || !version)
      die(
        "usage: kelson eval publish <run-id> <pack> <version> [--ledger <dir>]",
      );
    const db = openDb(dbPath);
    try {
      const path = writeLedgerEntry(db, {
        runId: runId as string,
        pack: pack as string,
        version: version as string,
        ledgerDir: str(named.ledger, join(process.cwd(), "ledger")),
      });
      write(`ledger entry written: ${path}`);
    } finally {
      db.close();
    }
    return;
  }

  die(
    `unknown eval subcommand: ${sub ?? "(none)"} (have: ablate, compare, suite promote, publish)`,
  );
};

// UX §3: kelson route explain <task> — read-only routing transparency.
const routeCommand = (argv: string[]): void => {
  if (argv[0] !== "explain")
    die(`unknown route subcommand: ${argv[0] ?? "(none)"} (have: explain)`);
  const { named } = parseArgs(argv.slice(1));
  const policy = loadPolicy(
    str(
      named.policy,
      join(process.cwd(), "packs/routing-default/routing/policy.yaml"),
    ),
  );
  const registry = loadRegistry(
    str(named.registry, join(process.cwd(), "packs/routing-default/agents")),
  );
  validatePolicyTargets(policy, registry);
  const vector = extractFeatures({
    step: str(named.step, "build") as never,
    repo: str(named.repo, "local"),
    ...(typeof named.tier === "string"
      ? { touchedTiers: [named.tier as never] }
      : {}),
    ...(named["task-type"] === "mechanical" ? { mechanical: true } : {}),
    ...(typeof named.lang === "string"
      ? { langCounts: { [named.lang]: 1 } }
      : {}),
  });
  const { spec, ruleIndex } = resolveRule(policy, vector);
  const agent = matchAgent(
    registry,
    vector,
    typeof named.domain === "string" ? named.domain : undefined,
  );
  const target = agent?.id ?? spec.target;
  const entry = registry.find((e) => e.id === target);
  const decision = {
    vector,
    rule_index: ruleIndex,
    target,
    model: entry?.endpoint.ref ?? null,
    effort: spec.effort,
    budget_tokens: spec.budget_tokens,
    escalation: spec.escalation,
    via_capability_match: agent !== null,
  };
  if (named.json === true) emitJson(decision);
  else
    write(
      kvGrid([
        [
          "route",
          `${target} (${entry?.endpoint.ref ?? "?"}) effort=${spec.effort} budget=${spec.budget_tokens}`,
        ],
        [
          "matched",
          `${ruleIndex === -1 ? "default rule" : `rule #${ruleIndex}`}${agent ? " overridden by capability match" : ""}`,
        ],
        ["escalation", spec.escalation.join(" -> ") || "(none)"],
        ["vector", JSON.stringify(decision.vector)],
      ]),
    );
};

// UX §3: kelson loop status|review|release|revert (+ propose/approve/apply).
const loopCommand = (argv: string[]): void => {
  const sub = argv[0];
  const { positional, named } = parseArgs(argv.slice(1));
  const db = openDb(str(named.db, DEFAULT_DB_PATH));
  const ctx = {
    lockfilePath: str(named.lockfile, join(process.cwd(), "kelson.lock")),
    changelogPath: str(
      named.changelog,
      join(process.cwd(), ".kelson", "changelog.jsonl"),
    ),
  };
  const repoRoot = process.cwd();
  try {
    if (sub === "propose") {
      const lockfile = loadLockfile(ctx.lockfilePath);
      const drafts = compileProposals(db, {
        ledgerDir: str(named.ledger, join(repoRoot, "ledger")),
        lockfile,
      });
      if (!drafts.length) {
        write("no conclusive evidence — nothing to propose");
        return;
      }
      for (const draft of drafts) {
        const proposal = createProposal(db, {
          targetPack: draft.targetPack,
          diff: draft.diff,
          evidence: draft.evidence,
          rationale: draft.rationale,
          createdBy: "loop",
          repoRoot,
          gatingSuiteIds: ["seed"],
        });
        write(`proposed ${proposal.id}: ${draft.rationale}`);
      }
      return;
    }
    if (sub === "status") {
      const rows = db
        .query(
          "SELECT id, target_pack, state, created_by, rationale FROM proposal ORDER BY rowid",
        )
        .all() as Record<string, string>[];
      if (!rows.length) write("no proposals — kelson loop propose");
      else
        write(
          table(
            [
              { header: "id" },
              { header: "state" },
              { header: "pack" },
              { header: "by" },
              { header: "rationale" },
            ],
            rows.map((r) => [
              r.id ?? "",
              r.state ?? "",
              r.target_pack ?? "",
              r.created_by ?? "",
              r.rationale?.slice(0, 60) ?? "",
            ]),
          ),
        );
      return;
    }
    if (sub === "review") {
      const id =
        positional[0] ?? die("usage: kelson loop review <id> [--run <run-id>]");
      const proposal = getProposal(db, id as string);
      emitJson(proposal);
      if (typeof named.run === "string") {
        // A standard gating ablate runs A = current lockfile, B = toggled —
        // so the proposal's candidate configuration is the toggled side B
        // (both for disable-of-enabled and enable-of-disabled). Override with
        // --candidate-side for compare runs with other geometries.
        const candidateSide = (
          typeof named["candidate-side"] === "string"
            ? named["candidate-side"]
            : "B"
        ) as "A" | "B";
        const basis = evaluateGate(db, {
          runId: named.run,
          replayConfig: str(named["replay-config"], proposal.diff_hash),
          candidateSide,
          ...(typeof named["min-sample"] === "string"
            ? { minSample: Number(named["min-sample"]) }
            : {}),
        });
        write(`gate basis: ${JSON.stringify(basis, null, 2)}`);
      }
      return;
    }
    if (sub === "gate") {
      const id = positional[0] ?? die("usage: kelson loop gate <id>");
      const proposal = enterGate(db, id as string, repoRoot);
      write(`${id} -> ${proposal.state}`);
      return;
    }
    if (sub === "approve" || sub === "reject") {
      const id =
        positional[0] ?? die(`usage: kelson loop ${sub} <id> --reason "..."`);
      // LOOP-2: a human approval names what it overrides — no boilerplate
      // default; the operator must state the reason.
      if (sub === "approve" && typeof named.reason !== "string")
        die(
          "loop approve requires an explicit --reason naming the gate basis it overrides (LOOP-2)",
        );
      const proposal = transition(
        db,
        id as string,
        sub === "approve" ? "approved" : "rejected",
        {
          actor: "human",
          reason: str(named.reason, `human ${sub}`),
        },
      );
      write(`${id} -> ${proposal.state}`);
      return;
    }
    if (sub === "apply") {
      const id = positional[0] ?? die("usage: kelson loop apply <id>");
      const { lockfileAfter } = applyProposal(db, id as string, ctx);
      const monitor = openMonitor(db, id as string, {
        appliedAt: new Date().toISOString(),
        lockfileAfter,
        changelog: readChangelog(ctx.changelogPath),
      });
      write(
        `applied ${id}; lockfile now ${lockfileAfter}; monitoring open (baseline n=${monitor.baseline_session_ids.length}${monitor.baseline_insufficient ? ", insufficient — alert-only" : ""})`,
      );
      return;
    }
    if (sub === "revert") {
      const id = positional[0] ?? die("usage: kelson loop revert <id>");
      const { lockfileAfter } = revertProposal(db, id as string, ctx, {
        actor: "human",
        reason: str(named.reason, "human revert"),
      });
      write(`reverted ${id}; lockfile now ${lockfileAfter}`);
      return;
    }
    if (sub === "release") {
      const id = positional[0] ?? die("usage: kelson loop release <id>");
      releaseQuarantined(db, id as string, "human");
      write(`released ${id} -> proposed (must re-pass the gate)`);
      return;
    }
    die(
      `unknown loop subcommand: ${sub ?? "(none)"} (have: propose, status, review, gate, approve, reject, apply, revert, release)`,
    );
  } finally {
    db.close();
  }
};

// OSS-1: one-command install — creates .kelson, a starter lockfile, and
// layers hooks into .claude/settings.json non-destructively (existing hooks
// and settings are preserved; ours append only if absent).
const initCommand = (argv: string[]): void => {
  const { named } = parseArgs(argv);
  const root = str(named.dir, process.cwd());

  mkdirSync(join(root, ".kelson", "telemetry"), { recursive: true });
  mkdirSync(join(root, ".claude", "hooks"), { recursive: true });

  const lockPath = join(root, "kelson.lock");
  if (!existsSync(lockPath)) {
    writeFileSync(
      lockPath,
      `${JSON.stringify({ schema_version: 1, parent_hash: null, entries: [] }, null, 2)}\n`,
    );
    write("created kelson.lock");
  } else write("kelson.lock exists — left untouched");

  const settingsPath = join(root, ".claude", "settings.json");
  const settings = existsSync(settingsPath)
    ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<
        string,
        unknown
      >)
    : {};
  const hooks = (settings.hooks ?? {}) as Record<
    string,
    { hooks: { type: string; command: string }[] }[]
  >;
  const ensure = (event: string, command: string) => {
    hooks[event] ??= [];
    const flat = hooks[event].flatMap((h) => h.hooks.map((x) => x.command));
    if (!flat.some((c) => c.includes(command.split("/").pop() as string))) {
      hooks[event].push({ hooks: [{ type: "command", command }] });
      write(`hooked ${event}`);
    } else write(`${event} hook exists — left untouched`);
  };
  ensure(
    "SessionStart",
    'bun "$CLAUDE_PROJECT_DIR/node_modules/kelson/../cc-plugin/hooks/session-start.ts"',
  );
  ensure(
    "SessionEnd",
    'bun "$CLAUDE_PROJECT_DIR/node_modules/kelson/../cc-plugin/hooks/session-end.ts"',
  );
  settings.hooks = hooks;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  const db = openDb(join(root, ".kelson", "kelson.db"));
  db.close();
  write(
    "kelson initialized: .kelson store ready, hooks layered, lockfile pinned",
  );
};

// PACK-3: kelson pack lint — required bump from diffing against the
// previous version's directory; declared bump below required exits 1.
const packCommand = (argv: string[]): void => {
  const { positional, named } = parseArgs(argv);
  const sub = positional[0];
  if (sub !== "lint") die("usage: kelson pack lint <dir> --prev <dir>");
  const dir =
    positional[1] ?? die("usage: kelson pack lint <dir> --prev <dir>");
  const prevDir =
    typeof named.prev === "string" ? named.prev : die("--prev <dir> required");
  const next = loadPack(dir as string);
  const prev = loadPack(prevDir);
  const required = requiredBump(prev, next);
  const declared = { prev: prev.manifest.version, next: next.manifest.version };
  if (!bumpSatisfies(declared, required))
    die(
      `pack lint (PACK-3): required bump "${required}" but ${declared.prev} -> ${declared.next} does not satisfy it`,
    );
  write(
    `pack lint: ok — required "${required}", declared ${declared.prev} -> ${declared.next}`,
  );
};

// UX-8: the one dispatch table — typed commands and launcher wizards both
// resolve through it, so a wizard cannot grow a parallel implementation.
export const COMMANDS: DispatchTable = {
  init: initCommand,
  eval: evalCommand,
  route: routeCommand,
  loop: loopCommand,
  pack: packCommand,
  ui: uiCommand,
  auth: async (argv) => (await import("./agent/auth.js")).authCommand(argv),
  run: async (argv) => (await import("./agent/run.js")).runCommand(argv),
  // UX-14: chat is TTY-only; non-TTY invocations are directed to `kelson run`.
  chat: async (argv) => {
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
      die('chat needs a terminal — use `kelson run -p "<task>"` instead');
    await (await import("./chat/app.js")).chatCommand(argv, COMMANDS);
  },
};

const help = (): void => {
  write(
    panel(
      "kelson",
      kvGrid([
        ["init", "install kelson into this repo"],
        ["eval", "ablate | compare | suite promote | publish"],
        ["route", "explain — show the routing decision"],
        ["loop", "propose | status | review | gate | approve | apply | revert"],
        ["pack", "lint — check a pack's version bump"],
        ["ui", "serve the local read-only web UI"],
        ["auth", "login <anthropic|ollama> — configure the native runtime"],
        ["run", 'run -p "<task>" — headless native session (--json)'],
        ["chat", "interactive native-runtime chat (TTY)"],
        ["", ""],
        ["(no command)", "in a terminal: interactive launcher (UX-7)"],
      ]),
    ),
  );
};

const main = async (): Promise<void> => {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === undefined) {
    // UX-7: TTY → launcher; anything else → plain help, exit 0, no prompt.
    if (process.stdin.isTTY === true && process.stdout.isTTY === true) {
      const { runLauncher } = await import("./launcher.js");
      await runLauncher(COMMANDS);
    } else help();
    return;
  }
  const entry = COMMANDS[cmd];
  if (!entry)
    die(`unknown command: ${cmd} (have: ${Object.keys(COMMANDS).join(", ")})`);
  else await entry(rest);
};

if (import.meta.main) await main();
