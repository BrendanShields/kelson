#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_DB_PATH,
  loadSuite,
  openDb,
  promoteTask,
  runEval,
  togglePack,
  writeLedgerEntry,
} from "@kelson/kernel";
import {
  type Executor,
  Lockfile,
  SandboxProfile,
  type Verdict,
} from "@kelson/schemas";

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
      if (json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`run ${result.runId} manifest ${result.manifestHash}`);
        for (const q of result.quarantine)
          console.log(
            `quarantined ${q.task_id} (window ${q.window.map((w) => (w ? "P" : "F")).join("")})`,
          );
        console.log(renderVerdict(result.verdict));
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
    console.log(`re-admitted ${taskId} to ${suite.id}@${suite.version}`);
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
      console.log(`ledger entry written: ${path}`);
    } finally {
      db.close();
    }
    return;
  }

  die(
    `unknown eval subcommand: ${sub ?? "(none)"} (have: ablate, compare, suite promote, publish)`,
  );
};

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "eval") evalCommand(rest);
else die(`unknown command: ${cmd ?? "(none)"} (have: eval)`);
