import type { Database } from "bun:sqlite";

export const FLAKY_DEFAULTS = { k: 5, minMinority: 2 } as const;

export interface QuarantineEvent {
  task_id: string;
  config: string;
  window: boolean[];
}

// EVP-5: window = most recent K results per (task, config lockfile hash),
// ordered by (run started_at, repeat_index), pooled across runs regardless of
// which side letter carried the hash; sides never mix because the hash is the
// key. Flaky = full window, mixed, minority >= min_minority. Quarantine is
// task-level and sticky (only `eval suite promote` clears it).
export const evaluateFlakiness = (
  db: Database,
  args: {
    suiteId: string;
    suiteVersion: string;
    configs: string[];
    k?: number;
    minMinority?: number;
  },
): QuarantineEvent[] => {
  const k = args.k ?? FLAKY_DEFAULTS.k;
  const minMinority = args.minMinority ?? FLAKY_DEFAULTS.minMinority;
  const tasks = db
    .query(
      "SELECT id FROM benchmark_task WHERE suite_id = ? AND suite_version = ? AND quarantined = 0",
    )
    .all(args.suiteId, args.suiteVersion) as { id: string }[];
  const events: QuarantineEvent[] = [];
  for (const task of tasks) {
    for (const config of args.configs) {
      const rows = db
        .query(
          `SELECT r.fpar_pass, r.schema_version FROM eval_task_result r
             JOIN eval_run er ON er.id = r.run_id
            WHERE r.bench_task_id = ?
              AND ((r.side = 'A' AND er.config_a = ?) OR (r.side = 'B' AND er.config_b = ?))
            ORDER BY er.started_at DESC, r.repeat_index DESC
            LIMIT ?`,
        )
        .all(task.id, config, config, k) as {
        fpar_pass: number;
        schema_version: number;
      }[];
      if (rows.length < k) continue;
      if (new Set(rows.map((r) => r.schema_version)).size > 1)
        throw new Error(
          `cross-schema-version flakiness window refused (OSS-6): task ${task.id} — migrate or re-run`,
        );
      const window = rows.reverse().map((r) => r.fpar_pass === 1);
      const passes = window.filter(Boolean).length;
      const minority = Math.min(passes, k - passes);
      if (minority >= minMinority) {
        db.query(
          "UPDATE benchmark_task SET quarantined = 1 WHERE id = ? AND suite_id = ? AND suite_version = ?",
        ).run(task.id, args.suiteId, args.suiteVersion);
        events.push({ task_id: task.id, config, window });
        break;
      }
    }
  }
  return events;
};

export const promoteTask = (
  db: Database,
  suiteId: string,
  suiteVersion: string,
  taskId: string,
): void => {
  db.query(
    "UPDATE benchmark_task SET quarantined = 0 WHERE id = ? AND suite_id = ? AND suite_version = ?",
  ).run(taskId, suiteId, suiteVersion);
};
