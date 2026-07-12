#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyProposal,
  bumpSatisfies,
  compileProposals,
  DEFAULT_DB_PATH,
  emitProposalCycle,
  enterGate,
  evalReport,
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
  runReplay,
  togglePack,
  transition,
  validatePolicyTargets,
  writeLedgerEntry,
} from "@obligato/kernel";
import {
  type Delta,
  EvalReportResult,
  Executor,
  type InitResult,
  Lockfile,
  type PackLintResult,
  PackManifest,
  type PackNewResult,
  ReplayResult,
  SandboxProfile,
  type Verdict,
} from "@obligato/schemas";
import { parseArgs } from "./args.js";
import { loadRepoRegistry, unionRegistries } from "./commands/agents.js";
import { kvGrid, panel, renderVerdict, table } from "./components/render.js";
import { write } from "./components/sink.js";
import { SYM } from "./components/theme.js";
import { emitJson } from "./output/json.js";
import { uiCommand } from "./ui/server.js";
import type { DispatchTable } from "./wizards.js";

const die = (msg: string): never => {
  console.error(`obligato: ${msg}`);
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

// UX J3 renderVerdict moved to components/render.ts (shared with bench).

const evalCommand = async (argv: string[]): Promise<void> => {
  const sub = argv[0];
  const { positional, named } = parseArgs(argv.slice(1));
  const dbPath = str(named.db, DEFAULT_DB_PATH);
  const json = named.json === true;

  if (sub === "ablate" || sub === "compare") {
    const suiteDir =
      typeof named.suite === "string"
        ? named.suite
        : die("--suite <dir> is required");
    const parsedExecutor = Executor.safeParse(str(named.executor, "claude"));
    if (!parsedExecutor.success)
      return die(
        `unknown executor: ${str(named.executor, "claude")} (have: ${Executor.options.join(", ")})`,
      );
    const executor = parsedExecutor.data;
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
        positional[0] ??
        die("usage: obligato eval ablate <pack> --suite <dir>");
      lockfileA = loadLockfile(
        str(named.lockfile, join(process.cwd(), "obligato.lock")),
      );
      lockfileB = togglePack(lockfileA, pack as string);
    } else {
      const [a, b] = positional;
      if (!a || !b)
        die("usage: obligato eval compare <lockA> <lockB> --suite <dir>");
      lockfileA = loadLockfile(a as string);
      lockfileB = loadLockfile(b as string);
    }
    const db = openDb(dbPath);
    try {
      // EVP-9: the composition root injects the native executor — kernel
      // never imports agent.
      const { apiExecutor } = await import("@obligato/agent");
      const result = await runEval(db, {
        kind: sub,
        suiteDir,
        lockfileA,
        lockfileB,
        executor,
        profile,
        extraExecutors: { api: apiExecutor },
        ...(typeof named.seed === "string" ? { seed: Number(named.seed) } : {}),
        ...(typeof named.repeats === "string"
          ? { repeats: Number(named.repeats) }
          : {}),
        // EVP-12: bounded cell concurrency, deterministic verdict either way.
        ...(typeof named.concurrency === "string"
          ? {
              concurrency: /^[1-9]\d*$/.test(named.concurrency)
                ? Number(named.concurrency)
                : die(
                    `--concurrency must be a positive integer, got "${named.concurrency}"`,
                  ),
            }
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
        write(renderVerdict(result.verdict, result.minSample));
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
      p[0] ?? die("usage: obligato eval suite promote <task-id> --suite <dir>");
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
        "usage: obligato eval publish <run-id> <pack> <version> [--ledger <dir>]",
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

  if (sub === "report") {
    const db = openDb(dbPath);
    try {
      const runs = evalReport(
        db,
        typeof named.since === "string" ? { since: named.since } : {},
      );
      const result = EvalReportResult.parse({ runs, schema_version: 1 });
      if (json) {
        emitJson(result);
        return;
      }
      if (runs.length === 0) {
        write(
          "no stored verdicts — run one: obligato eval ablate <pack> --suite <dir>",
        );
        return;
      }
      // UX-23/EVT-1: re-render from the store — decision + deltas with CIs,
      // never a bare label; nothing executes.
      const fmtDelta = (d: Delta): string =>
        `${d.mean.toFixed(3)} [${d.ci95[0].toFixed(3)}, ${d.ci95[1].toFixed(3)}]`;
      write(
        table(
          [
            { header: "run" },
            { header: "kind" },
            { header: "suite" },
            { header: "decision" },
            { header: "fpar Δ [ci95]" },
            { header: "cost%Δ [ci95]" },
            { header: "n", align: "right" },
          ],
          runs.map((r) => [
            r.run_id,
            r.kind,
            `${r.suite_id}@${r.suite_version}`,
            r.decision,
            fmtDelta(r.fpar_delta),
            fmtDelta(r.cost_delta_pct),
            String(r.n),
          ]),
        ),
      );
    } finally {
      db.close();
    }
    return;
  }

  if (sub === "replay") {
    const sessionId =
      typeof named.session === "string"
        ? named.session
        : die(
            "usage: obligato eval replay --session <id> --suite <staging-dir> --config <lockfile>",
          );
    const suiteDir =
      typeof named.suite === "string"
        ? named.suite
        : die(
            "--suite <staging-dir> is required (where the session was promoted)",
          );
    const configPath =
      typeof named.config === "string"
        ? named.config
        : die("--config <lockfile> is required (the candidate config)");
    const parsedExecutor = Executor.safeParse(str(named.executor, "claude"));
    if (!parsedExecutor.success)
      return die(
        `unknown executor: ${str(named.executor, "claude")} (have: ${Executor.options.join(", ")})`,
      );
    const isolation = str(named.profile, "worktree");
    const profile = SandboxProfile.parse({
      isolation,
      network:
        isolation === "container"
          ? { policy: "deny", allowlist: [] }
          : { policy: "inherit" },
    });
    const lockfile = loadLockfile(configPath);
    const db = openDb(dbPath);
    try {
      const { apiExecutor } = await import("@obligato/agent");
      const record = await runReplay(db, {
        sessionId,
        suiteDir,
        lockfile,
        profile,
        executor: parsedExecutor.data,
        extraExecutors: { api: apiExecutor },
        ...(typeof named.model === "string" ? { model: named.model } : {}),
        ...(typeof named.snapshots === "string"
          ? { snapshotStoreDir: named.snapshots }
          : {}),
      }).catch((e) => die((e as Error).message));
      if (json) {
        emitJson(ReplayResult.parse({ record, schema_version: 1 }));
        return;
      }
      const money = (musd: number): string =>
        `$${(musd / 1_000_000).toFixed(2)}`;
      write(
        kvGrid([
          ["replay", `${record.id} (run ${record.run_id ?? "?"})`],
          ["source session", record.source_session_id],
          [
            "validity",
            record.validity === "valid"
              ? `${SYM.pass} valid`
              : `${SYM.warn} advisory (${record.advisory_reason})`,
          ],
          [
            "replayed",
            `${record.outcome.fpar_pass ? SYM.pass : SYM.fail} fpar, ${money(record.outcome.cost_micro_usd)}`,
          ],
          [
            "original",
            `${record.outcome.original_fpar_pass ? SYM.pass : SYM.fail} fpar, ${money(record.outcome.original_cost_micro_usd)}`,
          ],
        ]),
      );
    } finally {
      db.close();
    }
    return;
  }

  die(
    `unknown eval subcommand: ${sub ?? "(none)"} (have: ablate, compare, replay, report, suite promote, publish)`,
  );
};

// UX §3: obligato route explain <task> — read-only routing transparency.
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
  const baseRegistry = loadRegistry(
    str(named.registry, join(process.cwd(), "packs/routing-default/agents")),
  );
  // UX-24: repo-registered agents (`obligato agents register`) union in as
  // candidates, repo entries winning by id; an explicit --registry opts out.
  const registry =
    typeof named.registry === "string"
      ? baseRegistry
      : unionRegistries(baseRegistry, loadRepoRegistry(process.cwd()));
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

// UX §3: obligato loop status|review|release|revert (+ propose/approve/apply).
const loopCommand = (argv: string[]): void => {
  const sub = argv[0];
  const { positional, named } = parseArgs(argv.slice(1));
  const db = openDb(str(named.db, DEFAULT_DB_PATH));
  const ctx = {
    lockfilePath: str(named.lockfile, join(process.cwd(), "obligato.lock")),
    changelogPath: str(
      named.changelog,
      join(process.cwd(), ".obligato", "changelog.jsonl"),
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
      const cycle = emitProposalCycle(db, {
        drafts,
        createdBy: "loop",
        repoRoot,
        gatingSuiteIds: ["seed"],
      });
      for (const proposal of cycle.proposals)
        write(`proposed ${proposal.id}: ${proposal.rationale}`);
      if (cycle.clipped > 0)
        write(
          `clipped ${cycle.clipped} candidate(s) over the edit budget (LOOP-10) — evidence stays minable for later cycles`,
        );
      return;
    }
    if (sub === "status") {
      const rows = db
        .query(
          "SELECT id, target_pack, state, created_by, rationale FROM proposal ORDER BY rowid",
        )
        .all() as Record<string, string>[];
      if (!rows.length) write("no proposals — obligato loop propose");
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
        positional[0] ??
        die("usage: obligato loop review <id> [--run <run-id>]");
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
      const id = positional[0] ?? die("usage: obligato loop gate <id>");
      const proposal = enterGate(db, id as string, repoRoot);
      write(`${id} -> ${proposal.state}`);
      return;
    }
    if (sub === "approve" || sub === "reject") {
      const id =
        positional[0] ?? die(`usage: obligato loop ${sub} <id> --reason "..."`);
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
      const id = positional[0] ?? die("usage: obligato loop apply <id>");
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
      const id = positional[0] ?? die("usage: obligato loop revert <id>");
      const { lockfileAfter } = revertProposal(db, id as string, ctx, {
        actor: "human",
        reason: str(named.reason, "human revert"),
      });
      write(`reverted ${id}; lockfile now ${lockfileAfter}`);
      return;
    }
    if (sub === "release") {
      const id = positional[0] ?? die("usage: obligato loop release <id>");
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

// OSS-1: one-command install — creates .obligato, a starter lockfile, and
// layers hooks into .claude/settings.json non-destructively (existing hooks
// and settings are preserved; ours append only if absent).
const initCommand = (argv: string[]): void => {
  const { named } = parseArgs(argv);
  const asJson = named.json === true;
  const say = (m: string) => {
    if (!asJson) write(m);
  };
  const root = str(named.dir, process.cwd());

  mkdirSync(join(root, ".obligato", "telemetry"), { recursive: true });
  mkdirSync(join(root, ".claude", "hooks"), { recursive: true });

  const lockPath = join(root, "obligato.lock");
  let lockfile: InitResult["lockfile"];
  if (!existsSync(lockPath)) {
    writeFileSync(
      lockPath,
      `${JSON.stringify({ schema_version: 1, parent_hash: null, entries: [] }, null, 2)}\n`,
    );
    lockfile = "created";
    say("created obligato.lock");
  } else {
    lockfile = "existing";
    say("obligato.lock exists — left untouched");
  }

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
  const hooked: string[] = [];
  const ensure = (event: string, command: string) => {
    hooks[event] ??= [];
    const flat = hooks[event].flatMap((h) => h.hooks.map((x) => x.command));
    if (!flat.some((c) => c.includes(command.split("/").pop() as string))) {
      hooks[event].push({ hooks: [{ type: "command", command }] });
      hooked.push(event);
      say(`hooked ${event}`);
    } else say(`${event} hook exists — left untouched`);
  };
  ensure(
    "SessionStart",
    'bun "$CLAUDE_PROJECT_DIR/node_modules/obligato/../cc-plugin/hooks/session-start.ts"',
  );
  ensure(
    "SessionEnd",
    'bun "$CLAUDE_PROJECT_DIR/node_modules/obligato/../cc-plugin/hooks/session-end.ts"',
  );
  settings.hooks = hooks;
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  const storePath = join(root, ".obligato", "obligato.db");
  const db = openDb(storePath);
  db.close();
  if (asJson)
    emitJson({
      store_path: storePath,
      lockfile,
      hooked,
      schema_version: 1,
    } satisfies InitResult);
  else
    write(
      "obligato initialized: .obligato store ready, hooks layered, lockfile pinned",
    );
};

// UX-21: obligato pack new — scaffold a pack whose manifest carries every
// required field with explicit capability declarations (SEC-4) consistent
// with the scaffolded content, self-lintable (`pack lint <dir> --prev <dir>`
// against itself requires bump "none").
const packNew = (argv: string[]): void => {
  const { positional, named } = parseArgs(argv);
  const name =
    positional[0] ??
    die("usage: obligato pack new <name> [--kind <kind>] [--dir <parent>]");
  const kind = str(named.kind, "efficiency");
  const description = `TODO: what ${name} improves, in one sentence`;
  // Validate before any write — an invalid name/kind scaffolds nothing.
  const parsed = PackManifest.safeParse({
    schema_version: 1,
    name,
    version: "1.0.0",
    kind,
    kernel_compat: "*",
    capabilities: ["rules"],
    description,
  });
  if (!parsed.success)
    return die(
      `invalid pack manifest (${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")})`,
    );
  const dir = join(str(named.dir, process.cwd()), name as string);
  if (existsSync(dir)) return die(`${dir} already exists`);
  mkdirSync(join(dir, "rules"), { recursive: true });
  writeFileSync(
    join(dir, "pack.yaml"),
    [
      "schema_version: 1",
      `name: ${name}`,
      'version: "1.0.0"',
      `kind: ${kind}`,
      "# semver range of kernels this pack supports",
      'kernel_compat: "*"',
      "# SEC-4 capability ceiling: every content dir maps to a capability",
      "# (rules/** -> rules); undeclared content is refused by the loader.",
      "capabilities:",
      "  - rules",
      `description: "${description}"`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "rules", "example.md"),
    `# ${name}: example rule\n\nReplace with the guidance this pack injects.\n`,
  );
  writeFileSync(
    join(dir, "README.md"),
    `# ${name}\n\nMeasure it before shipping it: \`obligato eval ablate ./${name} --suite <dir>\` (J5).\n`,
  );
  // Verified through the real loader — a scaffold the loader refuses is a bug.
  loadPack(dir);
  const files = ["pack.yaml", "rules/example.md", "README.md"];
  if (named.json === true) {
    emitJson({ dir, files, schema_version: 1 } satisfies PackNewResult);
    return;
  }
  write(`scaffolded ${dir} (${files.join(", ")})`);
  write(`lint it: obligato pack lint ${dir} --prev ${dir}`);
};

// PACK-3: obligato pack lint — required bump from diffing against the
// previous version's directory; declared bump below required exits 1.
const packCommand = (argv: string[]): void => {
  const { positional, named } = parseArgs(argv);
  const sub = positional[0];
  if (sub === "new") {
    packNew(argv.slice(1));
    return;
  }
  if (sub !== "lint")
    die(`unknown pack subcommand: ${sub ?? "(none)"} (have: lint, new)`);
  const dir =
    positional[1] ?? die("usage: obligato pack lint <dir> --prev <dir>");
  const prevDir =
    typeof named.prev === "string" ? named.prev : die("--prev <dir> required");
  const next = loadPack(dir as string);
  const prev = loadPack(prevDir);
  const required = requiredBump(prev, next);
  const declared = { prev: prev.manifest.version, next: next.manifest.version };
  const ok = bumpSatisfies(declared, required);
  if (named.json === true) {
    emitJson({
      ok,
      required_bump: required,
      prev_version: declared.prev,
      next_version: declared.next,
      schema_version: 1,
    } satisfies PackLintResult);
    if (!ok) process.exit(1);
    return;
  }
  if (!ok)
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
  // UX-14: chat is TTY-only; non-TTY invocations are directed to `obligato run`.
  chat: async (argv) => {
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
      die('chat needs a terminal — use `obligato run -p "<task>"` instead');
    await (await import("./chat/app.js")).chatCommand(argv, COMMANDS);
  },
  session: async (argv) =>
    (await import("./agent/session.js")).sessionCommand(argv),
  promote: async (argv) =>
    (await import("./agent/session.js")).promoteCommand(argv),
  bench: async (argv) =>
    (await import("./commands/bench.js")).benchCommand(argv),
  doctor: async (argv) =>
    (await import("./commands/doctor.js")).doctorCommand(argv),
  divergence: async (argv) =>
    (await import("./commands/divergence.js")).divergenceCommand(argv),
  drift: async (argv) =>
    (await import("./commands/drift.js")).driftCommand(argv),
  agents: async (argv) =>
    (await import("./commands/agents.js")).agentsCommand(argv),
  index: async (argv) =>
    (await import("./commands/reindex.js")).indexCommand(argv),
  db: async (argv) => (await import("./commands/db.js")).dbCommand(argv),
};

const help = (): void => {
  write(
    panel(
      "obligato",
      kvGrid([
        ["init", "install obligato into this repo"],
        [
          "eval",
          "ablate | compare | replay | report | suite promote | publish",
        ],
        ["route", "explain — show the routing decision"],
        ["loop", "propose | status | review | gate | approve | apply | revert"],
        ["pack", "lint | new — version-bump check, scaffold"],
        ["ui", "serve the local read-only web UI"],
        ["auth", "login <anthropic|ollama> — configure the native runtime"],
        ["run", 'run -p "<task>" — headless native session (--json)'],
        ["chat", "interactive native-runtime chat (TTY)"],
        [
          "session",
          "tree | fork | compare | compact — tree-session ops (UX-34)",
        ],
        ["promote", "<session> --suite <dir> — session → benchmark task"],
        ["bench", "--suite <dir> — native vs claude head-to-head (EVP-11)"],
        ["doctor", "self-check: each failing component and its fix"],
        ["divergence", "list | show <id> — recorded divergence reports"],
        ["drift", "list | promote — drift review, clause promotion (SPEC-8)"],
        ["agents", "register <manifest> | list — custom agent onboarding"],
        ["index", "rebuild — reconcile the artifact index from files"],
        ["db", "stats | backup <dest> — store size, row counts, snapshot"],
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
