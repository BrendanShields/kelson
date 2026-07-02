import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  hashContent,
  registerArtifact,
  rehashFromDisk,
} from "../src/artifacts.ts";
import { openDb } from "../src/storage.ts";
import { ulid } from "../src/ulid.ts";

describe("P0-4 verification: index rebuild from disk (ERD §1) and ULID shape", () => {
  it("rehash is idempotent and picks up file edits", () => {
    const dir = join(
      "/tmp",
      `kelson-art-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "spec.md"), "v1");
    const db = openDb(":memory:");
    registerArtifact(db, {
      repo: "r",
      logical_id: "spec.md",
      type: "spec",
      content: "v1",
    });

    expect(rehashFromDisk(db, "r", dir)).toEqual([]);
    writeFileSync(join(dir, "spec.md"), "v2");
    expect(rehashFromDisk(db, "r", dir)).toEqual(["spec.md"]);
    expect(rehashFromDisk(db, "r", dir)).toEqual([]);
    const row = db
      .query("SELECT content_hash FROM artifact WHERE logical_id = 'spec.md'")
      .get() as {
      content_hash: string;
    };
    expect(row.content_hash).toBe(hashContent("v2"));
    db.close();
  });

  it("ulid() matches the schemas scalar shape and is time-ordered", () => {
    const a = ulid(1);
    const b = ulid(2 ** 40);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(b).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});
