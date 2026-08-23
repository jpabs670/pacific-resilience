import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_DIR, REPO_ROOT } from "./support/fixtures.js";

/**
 * Architectural boundaries from ADR 0004 and the contracts package header.
 *
 * These rules decay if they live only in prose, so they are asserted here. The
 * constraints apply to `src/`; tests may use the filesystem, which is how this
 * file reads the sources it checks.
 */

const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "sqlite",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

const ALLOWED_EXTERNAL_IMPORTS = new Set(["zod"]);

function typescriptFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
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

/** Every `from "..."`, bare `import "..."`, dynamic `import("...")`, and `require("...")`. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

function packageDirectories(): string[] {
  const packagesRoot = join(REPO_ROOT, "packages");
  if (!existsSync(packagesRoot)) {
    return [];
  }
  return readdirSync(packagesRoot)
    .map((entry) => join(packagesRoot, entry))
    .filter((path) => statSync(path).isDirectory());
}

const contractsSources = typescriptFiles(join(PACKAGE_DIR, "src"));

describe("contracts sources exist and are discoverable", () => {
  it("finds the source files it is asserting about", () => {
    expect(contractsSources.length).toBeGreaterThanOrEqual(10);
  });
});

describe("packages/contracts/src has no environmental dependencies", () => {
  it("imports nothing but zod and its own relative modules", () => {
    for (const file of contractsSources) {
      const source = readFileSync(file, "utf8");
      for (const specifier of importSpecifiers(source)) {
        const label = `${relative(REPO_ROOT, file)} imports "${specifier}"`;
        if (specifier.startsWith(".")) {
          continue;
        }
        expect(specifier.startsWith("node:"), label).toBe(false);
        expect(NODE_BUILTINS.has(specifier), label).toBe(false);
        expect(ALLOWED_EXTERNAL_IMPORTS.has(specifier), label).toBe(true);
      }
    }
  });

  it("reads no environment, filesystem, network, or process state", () => {
    const forbidden = [
      "process.env",
      "process.argv",
      "process.cwd",
      "globalThis.process",
      "readFileSync",
      "writeFileSync",
      "fetch(",
      "XMLHttpRequest",
      "new Worker",
      "child_process",
    ];
    for (const file of contractsSources) {
      const source = readFileSync(file, "utf8");
      for (const token of forbidden) {
        expect(source.includes(token), `${relative(REPO_ROOT, file)} contains "${token}"`).toBe(
          false,
        );
      }
    }
  });

  it("generates no identifiers", () => {
    // Reading IDs are assigned by the component that creates the reading.
    const forbidden = ["randomUUID", "Math.random", "randomBytes", "webcrypto"];
    for (const file of contractsSources) {
      const source = readFileSync(file, "utf8");
      for (const token of forbidden) {
        expect(source.includes(token), `${relative(REPO_ROOT, file)} contains "${token}"`).toBe(
          false,
        );
      }
    }
  });

  it("reads no clock", () => {
    for (const file of contractsSources) {
      const source = readFileSync(file, "utf8");
      expect(source.includes("Date.now"), relative(REPO_ROOT, file)).toBe(false);
      expect(/new Date\(\s*\)/.test(source), relative(REPO_ROOT, file)).toBe(false);
    }
  });
});

describe("no package imports from apps/ or edge/ (ADR 0004)", () => {
  it("holds for every workspace under packages/", () => {
    for (const packageDir of packageDirectories()) {
      const files = [
        ...typescriptFiles(join(packageDir, "src")),
        ...typescriptFiles(join(packageDir, "test")),
      ];
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        for (const specifier of importSpecifiers(source)) {
          const label = `${relative(REPO_ROOT, file)} imports "${specifier}"`;
          expect(/(^|\/)apps\//.test(specifier), label).toBe(false);
          expect(/(^|\/)edge\//.test(specifier), label).toBe(false);
        }
      }
    }
  });
});

describe("contracts declares no workspace dependency", () => {
  it("depends only on zod", () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(["zod"]);
    expect(manifest.devDependencies ?? {}).toEqual({});
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      expect(name.startsWith("@pacific-resilience/")).toBe(false);
    }
  });
});

describe("no vendor, device, or protocol dependency exists yet", () => {
  it("keeps the dependency graph free of hardware libraries", () => {
    const lock = readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8").toLowerCase();
    for (const forbidden of ["modbus", "serialport", "node-serial", "mqtt", "anker", "solix"]) {
      expect(lock.includes(`/${forbidden}`), `lockfile references ${forbidden}`).toBe(false);
    }
  });
});
