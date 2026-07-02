import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  hashPackContent,
  loadPack,
  verifyPackContent,
  verifyPackSignature,
} from "../../src/packs.ts";
import { generatePackKeys, signPack } from "../../src/supply.ts";
import { makePack } from "./SEC-4.test.ts";

const FILES: Record<string, string> = {
  "pack.yaml": "schema_version: 1\nname: fixture\n",
  "rules/a.md": "rule content",
  "skills/build/b.md": "skill content",
};

const writePack = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "kelson-tamper-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
};

describe("PACK-2: hash + Ed25519 signature verified at install; unsigned installs are untrusted", () => {
  it("verify passes on untampered content and refuses after any single-byte flip", () => {
    const dir = writePack(FILES);
    const expected = hashPackContent(dir);
    verifyPackContent(dir, expected);

    for (const path of Object.keys(FILES)) {
      const target = join(dir, path);
      const original = readFileSync(target);
      const tampered = Buffer.from(original);
      tampered[0] = (tampered[0] ?? 0) ^ 0xff;
      writeFileSync(target, tampered);
      expect(() => verifyPackContent(dir, expected)).toThrow(/mismatch/);
      writeFileSync(target, original);
      verifyPackContent(dir, expected);
    }
  });

  it("pack.sig is excluded from the content hash — the signature cannot cover itself", () => {
    const dir = writePack(FILES);
    const before = hashPackContent(dir);
    writeFileSync(join(dir, "pack.sig"), "detached-signature");
    expect(hashPackContent(dir)).toBe(before);
  });

  it("renaming a path changes the hash even with identical bytes (path + \\0 + bytes)", () => {
    const a = writePack({ "rules/a.md": "same" });
    const b = writePack({ "rules/b.md": "same" });
    expect(hashPackContent(a)).not.toBe(hashPackContent(b));
  });

  it("Ed25519: signed pack verifies; tampered, unsigned, or wrong-key installs are refused", () => {
    const { publicKeyPem, privateKeyPem } = generatePackKeys();
    const dir = makePack(["rules"], { "rules/a.md": "be terse" });
    expect(() => verifyPackSignature(dir, publicKeyPem)).toThrow(/unsigned/);
    signPack(dir, privateKeyPem);
    verifyPackSignature(dir, publicKeyPem); // no throw
    writeFileSync(join(dir, "rules/a.md"), "be terse (tampered)");
    expect(() => verifyPackSignature(dir, publicKeyPem)).toThrow(
      /signature verification failed/,
    );
    const other = generatePackKeys();
    writeFileSync(join(dir, "rules/a.md"), "be terse");
    expect(() => verifyPackSignature(dir, other.publicKeyPem)).toThrow(
      /signature verification failed/,
    );
  });

  it("--unsigned loads carry the untrusted flag; signed loads do not", () => {
    const { publicKeyPem, privateKeyPem } = generatePackKeys();
    const dir = makePack(["rules"], { "rules/a.md": "x" });
    expect(loadPack(dir, { signature: "unsigned" }).untrusted).toBe(true);
    signPack(dir, privateKeyPem);
    expect(loadPack(dir, { signature: { publicKeyPem } }).untrusted).toBe(
      false,
    );
    // Telemetry-event propagation of the flag is a recorded deferral
    // (needs install/session wiring) — see the findings ledger.
  });
});
