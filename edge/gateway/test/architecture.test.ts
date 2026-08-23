import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Safety and layering boundaries.
 *
 * `docs/security/safety-boundary.md` states the rule that matters most in this
 * repository: the platform observes, it does not act. A boundary that fails a build
 * catches a control path arriving through someone's convenient scaffolding; a
 * boundary written only in a document does not catch it at all.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = join(PACKAGE_DIR, "..", "..");

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      if (entry === "node_modules" || entry === "dist") {
        continue;
      }
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith(".ts") || entry.endsWith(".mjs")) {
        files.push(path);
      }
    }
  };
  walk(dir);
  return files;
}

/** Comments are stripped so that documenting a prohibition cannot trip it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function workspaceRoots(): string[] {
  const roots: string[] = [];
  for (const group of ["packages", "edge", "apps"]) {
    const groupDir = join(REPO_ROOT, group);
    if (!existsSync(groupDir)) {
      continue;
    }
    for (const entry of readdirSync(groupDir).sort()) {
      const path = join(groupDir, entry);
      if (statSync(path).isDirectory()) {
        roots.push(path);
      }
    }
  }
  return roots;
}

function read(paths: readonly string[]) {
  return paths.map((path) => ({
    label: relative(REPO_ROOT, path),
    code: code(readFileSync(path, "utf8")),
  }));
}

/**
 * Production sources only.
 *
 * Test files are where prohibitions are *named* — a test that asserts "no
 * serialport" necessarily contains the word "serialport" — so scanning them for
 * forbidden vocabulary guarantees false positives. The claim being asserted is that
 * no shipped source can control equipment.
 */
const productionSources = read(workspaceRoots().flatMap((root) => sourceFiles(join(root, "src"))));

/** Sources plus tests, for import-layering rules where test imports matter too. */
const allSources = read(
  workspaceRoots().flatMap((root) => [
    ...sourceFiles(join(root, "src")),
    ...sourceFiles(join(root, "test")),
  ]),
);

const gatewaySources = sourceFiles(join(PACKAGE_DIR, "src")).map((path) => ({
  label: relative(REPO_ROOT, path),
  code: code(readFileSync(path, "utf8")),
}));

describe("no code can control physical equipment", () => {
  const controlPatterns: readonly RegExp[] = [
    /\bactuate\w*/i,
    /\benergi[sz]e\w*/i,
    /\b(open|close|trip|reset|toggle)(Breaker|Relay|Contactor|TransferSwitch|Disconnect)\b/i,
    /\b(start|stop|crank)(Generator|Genset)\b/i,
    /\bwrite(Register|Coil|Holding|Discrete)\b/i,
    /\bsendCommand\b/i,
    /\bcommandAsset\b/i,
    /\btransferTo\b/i,
    /\bsetSource\b/i,
    /\brelay(On|Off)\b/i,
    /\bloadShed\w*/i,
  ];

  it("scans every workspace source file", () => {
    expect(productionSources.length).toBeGreaterThanOrEqual(20);
  });

  it("contains no actuation vocabulary in any shipped source", () => {
    for (const source of productionSources) {
      for (const pattern of controlPatterns) {
        const match = source.code.match(pattern);
        expect(match, `${source.label} contains ${match?.[0] ?? ""}`).toBeNull();
      }
    }
  });

  it("exposes no device channel the platform could command through", () => {
    const channels = [
      "serialport",
      "node-serialport",
      "modbus",
      "jsmodbus",
      "node:i2c",
      "onoff",
      "rpio",
      "node-canbus",
      "bacnet",
      "dnp3",
    ];
    for (const source of productionSources) {
      for (const channel of channels) {
        expect(source.code.includes(channel), `${source.label} references ${channel}`).toBe(false);
      }
    }
  });

  it("keeps the installed dependency graph free of device and vendor libraries", () => {
    const lock = readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8").toLowerCase();
    for (const forbidden of [
      "modbus",
      "serialport",
      "node-serial",
      "mqtt",
      "bacnet",
      "dnp3",
      "anker",
      "solix",
    ]) {
      expect(lock.includes(`/${forbidden}`), `lockfile references ${forbidden}`).toBe(false);
    }
  });
});

describe("the gateway reaches no network in Phase 2", () => {
  it("ships no transport implementation", () => {
    // The interface is defined and the flush engine is written against it; the
    // ingest endpoint does not exist yet, and a network client now would put an
    // untestable dependency in the durability path.
    const forbidden = [
      "node:http",
      "node:https",
      "node:net",
      "node:tls",
      "node:dgram",
      "fetch(",
      "XMLHttpRequest",
      "WebSocket",
      "undici",
      "axios",
    ];
    for (const source of gatewaySources) {
      for (const token of forbidden) {
        expect(source.code.includes(token), `${source.label} contains "${token}"`).toBe(false);
      }
    }
  });
});

describe("layering (ADR 0004)", () => {
  it("keeps edge and apps packages from importing each other", () => {
    for (const source of allSources) {
      for (const pattern of [
        /from\s+["'][^"']*@pacific-resilience\/(gateway|simulator)["']/,
        /from\s+["'][^"']*\/(apps)\//,
      ]) {
        if (source.label.startsWith("edge/gateway") && pattern.source.includes("gateway")) {
          continue;
        }
        if (source.label.startsWith("edge/simulator") && pattern.source.includes("simulator")) {
          continue;
        }
        const match = source.code.match(pattern);
        expect(match, `${source.label} imports ${match?.[0] ?? ""}`).toBeNull();
      }
    }
  });

  it("declares only the dependencies Phase 2 needs", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      "@pacific-resilience/contracts",
      "better-sqlite3",
    ]);
    expect(Object.keys(manifest.devDependencies ?? {})).toEqual(["@types/better-sqlite3"]);
  });

  it("does not depend on the simulator", () => {
    const manifest = readFileSync(join(PACKAGE_DIR, "package.json"), "utf8");
    expect(manifest.includes("@pacific-resilience/simulator")).toBe(false);
  });
});

describe("the outbox never deletes unsent data", () => {
  const outbox = gatewaySources.find((source) => source.label.endsWith("outbox.ts"));
  const gateway = gatewaySources.find((source) => source.label.endsWith("gateway.ts"));

  it("has exactly one DELETE, guarded to acknowledged rows", () => {
    // One statement, so the guarantee is a property of the SQL rather than of every
    // call site remembering to be careful. Capacity reclamation and an operator's
    // retention pass both go through this one place.
    expect(outbox).toBeDefined();
    const deletes = outbox?.code.match(/DELETE FROM/g) ?? [];
    expect(deletes.length).toBe(1);
    expect(outbox?.code).toMatch(/DELETE FROM outbox WHERE acked_at IS NOT NULL/);
  });

  it("deletes nothing at all in the flush path", () => {
    // The gateway decides what to send and what an acknowledgement means. It has no
    // business removing rows, and the absence of the vocabulary is the cheapest way
    // to keep it that way.
    expect(gateway).toBeDefined();
    for (const token of ["DELETE", "prune", "deleteAcknowledged"]) {
      expect(gateway?.code.includes(token), `gateway.ts references ${token}`).toBe(false);
    }
  });

  it("offers no way to advance the cursor past a held range", () => {
    // Releasing a quarantine retries the range. Skipping it would mark unsent
    // readings delivered, which is the silent loss the whole design refuses. There
    // is no such operation, and this fails the build if one appears.
    for (const token of ["skipQuarantine", "forceAcknowledge", "discardRange", "abandonRange"]) {
      expect(outbox?.code.includes(token), `outbox.ts exposes ${token}`).toBe(false);
    }
    expect(outbox?.code).toMatch(/releaseQuarantine/);
  });

  it("takes the write lock up front on every write transaction", () => {
    // Every write here reads state and then commits a decision based on it: the
    // capacity check, the sequence counter, the cursor, the active hold. A DEFERRED
    // transaction acquires no write lock until its first write, so a second handle
    // can commit in between and the read is stale on arrival. IMMEDIATE serialises
    // the writers instead. Counted rather than eyeballed, so a later addition cannot
    // quietly reintroduce a deferred write.
    const transactions = outbox?.code.match(/db\.transaction\(/g) ?? [];
    const immediate = outbox?.code.match(/\.immediate\(\)/g) ?? [];
    expect(transactions.length).toBeGreaterThanOrEqual(4);
    expect(immediate.length).toBe(transactions.length);
  });
});
