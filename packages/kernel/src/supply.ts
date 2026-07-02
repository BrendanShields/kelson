import { sign as edSign, generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedPack } from "./packs.ts";
import { hashPackContent, verifyPackSignature } from "./packs.ts";

export { verifyPackSignature };

// PACK-2 / SEC-5: Ed25519 over the pack content hash. The private key never
// enters the repo (keys live under .kelson/keys/, gitignored); the public
// key is committed/registry-published.
export const generatePackKeys = (): {
  publicKeyPem: string;
  privateKeyPem: string;
} => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
  };
};

export const signPack = (dir: string, privateKeyPem: string): string => {
  const hash = hashPackContent(dir);
  const signature = edSign(null, Buffer.from(hash), privateKeyPem).toString(
    "base64",
  );
  writeFileSync(join(dir, "pack.sig"), `${signature}\n`);
  return signature;
};

// verifyPackSignature lives in packs.ts (loadPack calls it; avoids a cycle).

// SEC-5: static scan for injection patterns — instructions targeting other
// packs, the gate, telemetry, or exfiltration. Pattern-based by design: the
// scanner gates entry to eval, it is not the last line of defense (SEC-4/6
// capability and write isolation are structural).
const INJECTION_PATTERNS: { pattern: RegExp; label: string }[] = [
  {
    pattern:
      /ignore\s+((all|previous|prior)\s+)*(instructions|rules|constraints)/i,
    label: "instruction-override",
  },
  {
    pattern: /disregard\s+(the\s+)?(system|spec|gate|previous)/i,
    label: "instruction-override",
  },
  {
    pattern:
      /disable\s+(the\s+)?(gate|eval|telemetry|monitor|guard|scanner|check)/i,
    label: "gate-tampering",
  },
  {
    pattern: /bypass\s+(the\s+)?(gate|eval|review|approval|signature)/i,
    label: "gate-tampering",
  },
  {
    pattern:
      /(modify|edit|rewrite|overwrite)\s+(the\s+)?(lockfile|kelson\.lock|other\s+packs?|kernel)/i,
    label: "write-escalation",
  },
  {
    pattern:
      /(send|post|upload|transmit|exfiltrat\w*)\s+.{0,40}(http|www\.|api\.|webhook|server)/i,
    label: "exfiltration",
  },
  { pattern: /curl\s+-[a-z]*d|wget\s+--post/i, label: "exfiltration" },
  {
    pattern:
      /(read|cat|include)\s+.{0,30}(\.env|credentials|secret|api[_-]?key|token)/i,
    label: "credential-access",
  },
  {
    pattern:
      /pretend\s+(to\s+be|you\s+are)|act\s+as\s+(the\s+)?(gate|kernel|human|approver)/i,
    label: "impersonation",
  },
  {
    pattern: /approve\s+(all|every|any)\s+(proposal|diff|change)/i,
    label: "gate-tampering",
  },
];

export interface ScanFinding {
  file: string;
  label: string;
  excerpt: string;
}

export const scanPack = (dir: string): ScanFinding[] => {
  const findings: ScanFinding[] = [];
  const walk = (d: string, rel = ""): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(d, entry.name), path);
        continue;
      }
      if (!/\.(md|yaml|yml|txt|json)$/.test(entry.name)) continue;
      const text = readFileSync(join(d, entry.name), "utf8");
      for (const { pattern, label } of INJECTION_PATTERNS) {
        const match = text.match(pattern);
        if (match)
          findings.push({
            file: path,
            label,
            excerpt: (match[0] ?? "").slice(0, 80),
          });
      }
    }
  };
  walk(dir);
  return findings;
};

// PACK-3: capabilities/kind change → major; entry content change → minor;
// manifest-metadata-only change → patch; byte-identical → none.
export const requiredBump = (
  prev: LoadedPack,
  next: LoadedPack,
): "major" | "minor" | "patch" | "none" => {
  const caps = (p: LoadedPack) => [...p.manifest.capabilities].sort().join(",");
  if (caps(prev) !== caps(next) || prev.manifest.kind !== next.manifest.kind)
    return "major";
  if (prev.entries_hash !== next.entries_hash) return "minor";
  if (prev.content_hash !== next.content_hash) return "patch";
  return "none";
};

export const bumpSatisfies = (
  declared: { prev: string; next: string },
  required: "major" | "minor" | "patch" | "none",
): boolean => {
  const [pM, pm, pp] = declared.prev.split(".").map(Number) as [
    number,
    number,
    number,
  ];
  const [nM, nm, np] = declared.next.split(".").map(Number) as [
    number,
    number,
    number,
  ];
  if (required === "none") return true;
  if (required === "major") return nM > pM;
  if (required === "minor") return nM > pM || (nM === pM && nm > pm);
  return (
    nM > pM || (nM === pM && nm > pm) || (nM === pM && nm === pm && np > pp)
  );
};
