import {
  BenchReport,
  DivergenceListResult,
  DoctorReport,
  IndexRebuildResult,
  InitResult,
  RunResult,
} from "@kelson/schemas";
import type { ZodType } from "zod";

// UX-1: every COMMANDS entry maps here to its declared --json output schema or a
// recorded reason it isn't matrix-validated. The obligation test fails closed on
// any command absent from this map, so a newly-registered command must declare
// its --json contract (or why it has none) before it can ship.
export type JsonOutput = { schema: ZodType } | { skip: string };

export const JSON_OUTPUT: Record<string, JsonOutput> = {
  init: { schema: InitResult },
  pack: {
    skip: "per-subcommand shapes: lint emits PackLintResult (UX-1 live-check), new emits PackNewResult (UX-21)",
  },
  run: { schema: RunResult },
  bench: { schema: BenchReport },
  doctor: { schema: DoctorReport },
  divergence: { schema: DivergenceListResult },
  index: { schema: IndexRebuildResult },
  db: {
    skip: "per-subcommand shapes: stats emits DbStatsResult, backup emits DbBackupResult; validated by UX-27 obligation",
  },
  drift: {
    skip: "per-subcommand shapes: list emits DriftListResult, promote mutates; validated by UX-22 obligations",
  },
  agents: {
    skip: "register mutates the registry; list emits AgentsListResult, validated by UX-24 obligation",
  },
  eval: {
    skip: "per-subcommand verdict/underpowered JSON, validated by EVP/UX-J3 obligations; report/replay by UX-23",
  },
  route: { skip: "route --json validated by RTR/RPOL obligations" },
  loop: { skip: "many subcommand shapes; validated by LOOP obligations" },
  session: { skip: "session --json validated by SES obligations" },
  promote: { skip: "promote --json validated by SES/EVP obligations" },
  auth: { skip: "mutates credential state; no data view (PROV)" },
  ui: { skip: "long-running localhost server, not a one-shot view (UX-11)" },
  chat: { skip: "interactive TUI; non-TTY routes to run (UX-14)" },
};
