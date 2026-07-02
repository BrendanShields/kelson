import type { Database } from "bun:sqlite";
import {
  type BundleEvent,
  type BundleManifestEntry,
  BundleMissEvent,
} from "@kelson/schemas";
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { hashContent } from "./artifacts.ts";
import { ulid } from "./ulid.ts";

// CTX-5: one version-pinned local tokenizer on both sides of the CTX-1
// comparison, identity recorded on every bundle event.
export const TOKENIZER_ID = "o200k_base@gpt-tokenizer@3.4.0";

export const countTokens = (text: string): number => encode(text).length;

export interface BundleItem {
  kind: BundleManifestEntry["kind"];
  ref: string;
  content: string;
}

export interface CompiledBundle {
  text: string;
  token_count: number;
  manifest: BundleManifestEntry[];
  tokenizer: string;
}

const frame = (item: BundleItem): string =>
  `### ${item.kind}:${item.ref}\n${item.content}`;

const SEPARATOR = "\n\n";

// CTX-1: the recorded count is the whole-text tokenization of exactly the
// assembled string — accounting matches actual by construction. The manifest
// keeps per-section counts; the obligation's independent route re-derives the
// total from those sums (they differ from the whole only by BPE seam merges,
// which the 2% absorbs at realistic bundle sizes).
// CTX-5: no bundleable content → empty bundle, exactly zero, no preamble.
export const compileBundle = (items: BundleItem[]): CompiledBundle => {
  if (items.length === 0)
    return { text: "", token_count: 0, manifest: [], tokenizer: TOKENIZER_ID };
  const framed = items.map(frame);
  const manifest: BundleManifestEntry[] = items.map((item, i) => ({
    kind: item.kind,
    ref: item.ref,
    hash: hashContent(framed[i] as string),
    tokens: countTokens(framed[i] as string),
  }));
  const text = framed.join(SEPARATOR);
  return {
    text,
    token_count: countTokens(text),
    manifest,
    tokenizer: TOKENIZER_ID,
  };
};

export const recordBundle = (
  db: Database,
  taskId: string,
  bundle: CompiledBundle,
): BundleEvent => {
  const event: BundleEvent = {
    id: ulid(),
    task_id: taskId,
    tokenizer: bundle.tokenizer,
    token_count: bundle.token_count,
    manifest: bundle.manifest,
    at: new Date().toISOString(),
    schema_version: 1,
  };
  db.query(
    "INSERT INTO bundle_event (id, task_id, tokenizer, token_count, manifest, at, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    event.id,
    event.task_id,
    event.tokenizer,
    event.token_count,
    JSON.stringify(event.manifest),
    event.at,
    event.schema_version,
  );
  return event;
};

// CTX-1: on-demand loads join the accounting as their own events; the
// original bundle event is never mutated.
export const recordBundleMiss = (
  db: Database,
  bundleId: string,
  ref: string,
  content: string,
): BundleMissEvent => {
  const event = BundleMissEvent.parse({
    id: ulid(),
    bundle_id: bundleId,
    ref,
    // CTX-5: the count is over exactly the delivered content — no synthetic
    // frame that never reaches context.
    tokens: countTokens(content),
    at: new Date().toISOString(),
    schema_version: 1,
  });
  db.query(
    "INSERT INTO bundle_miss_event (id, bundle_id, ref, tokens, at, schema_version) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    event.id,
    event.bundle_id,
    event.ref,
    event.tokens,
    event.at,
    event.schema_version,
  );
  return event;
};

export const recordedTotal = (db: Database, bundleId: string): number => {
  const bundle = db
    .query("SELECT token_count FROM bundle_event WHERE id = ?")
    .get(bundleId) as { token_count: number } | null;
  if (!bundle) throw new Error(`unknown bundle: ${bundleId}`);
  const misses = db
    .query(
      "SELECT COALESCE(SUM(tokens), 0) AS n FROM bundle_miss_event WHERE bundle_id = ?",
    )
    .get(bundleId) as { n: number };
  return bundle.token_count + misses.n;
};
