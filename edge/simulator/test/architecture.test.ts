import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Constraints that make this package a simulator rather than a source of truth.
 *
 * Stated in prose in `src/index.ts` and asserted here, because a rule that lives
 * only in a comment decays.
 */

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = join(PACKAGE_DIR, "src");

function typescriptFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith(".ts")) {
        files.push(path);
      }
    }
  };
  walk(dir);
  return files;
}

/** Comments are excluded so that documenting a prohibition cannot trip it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const sources = typescriptFiles(SRC_DIR).map((path) => ({
  label: relative(PACKAGE_DIR, path),
  code: code(readFileSync(path, "utf8")),
}));

describe("the simulator is deterministic by construction", () => {
  it("finds the sources it asserts about", () => {
    expect(sources.length).toBeGreaterThanOrEqual(5);
  });

  it("uses no unseeded randomness", () => {
    // The only entropy is the caller's seed, plus the injectable id factory.
    for (const source of sources) {
      expect(source.code.includes("Math.random"), source.label).toBe(false);
    }
  });

  it("reads no clock", () => {
    // Timestamps are computed from startedAt and the tick index, so a run is
    // reproducible on any machine at any time.
    for (const source of sources) {
      expect(source.code.includes("Date.now"), source.label).toBe(false);
      expect(/new Date\(\s*\)/.test(source.code), source.label).toBe(false);
      expect(source.code.includes("performance.now"), source.label).toBe(false);
    }
  });

  it("hard-codes no origin other than simulated", () => {
    for (const source of sources) {
      for (const origin of ['"measured"', '"imported"', '"manual"']) {
        expect(source.code.includes(origin), `${source.label} mentions ${origin}`).toBe(false);
      }
    }
  });

  it("emits no derived record", () => {
    // `inferred` and `estimated` belong to event detection, where lineage can be
    // checked against stored inputs.
    for (const source of sources) {
      expect(source.code.includes('"inferred"'), source.label).toBe(false);
      expect(source.code.includes('"estimated"'), source.label).toBe(false);
    }
  });
});

describe("the simulator reaches no network and no device", () => {
  const forbidden = [
    "node:net",
    "node:http",
    "node:https",
    "node:dgram",
    "node:tls",
    "node:worker_threads",
    "node:child_process",
    "fetch(",
    "XMLHttpRequest",
    "serialport",
    "modbus",
  ];

  it("imports and calls none of them", () => {
    for (const source of sources) {
      for (const token of forbidden) {
        expect(source.code.includes(token), `${source.label} contains "${token}"`).toBe(false);
      }
    }
  });
});

describe("no code can control physical equipment", () => {
  const controlPatterns: readonly RegExp[] = [
    /\bactuate\w*/i,
    /\benergi[sz]e\w*/i,
    /\b(open|close|trip|reset)(Breaker|Relay|Contactor|TransferSwitch)\b/i,
    /\b(start|stop)(Generator|Genset)\b/i,
    /\bwrite(Register|Coil|Holding)\b/i,
    /\bsendCommand\b/i,
    /\btransferTo\b/i,
    /\brelay(On|Off)\b/i,
  ];

  it("contains no actuation vocabulary", () => {
    for (const source of sources) {
      for (const pattern of controlPatterns) {
        const match = source.code.match(pattern);
        expect(match, `${source.label} contains ${match?.[0] ?? ""}`).toBeNull();
      }
    }
  });
});
