import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fixture loading for tests.
 *
 * Tests may use the filesystem; `src/` may not. That boundary is asserted by
 * `test/architecture.test.ts`.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURES_DIR = join(HERE, "..", "fixtures");
export const PACKAGE_DIR = join(HERE, "..", "..");
export const REPO_ROOT = join(PACKAGE_DIR, "..", "..");

/** Fixture identifiers are drawn from this reserved synthetic block. */
export const RESERVED_FIXTURE_UUID_PREFIX = "00000000-0000-4000-8000-";

export type ExpectedIssue = { readonly path: string; readonly code: string };

export type ValidFixture = {
  readonly name: string;
  readonly intent: string;
  readonly value: unknown;
};

export type InvalidFixture = ValidFixture & {
  readonly expect: readonly ExpectedIssue[];
};

function asRecord(value: unknown, file: string): ReadonlyMap<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`fixture ${file} must contain a JSON object`);
  }
  // A Map rather than an index signature: reading unvalidated JSON through
  // `get` keeps both the TypeScript index-access rules and the linter's
  // literal-key rule satisfied, without weakening either.
  return new Map(Object.entries(value as Record<string, unknown>));
}

function requireIntent(record: ReadonlyMap<string, unknown>, file: string): string {
  const intent = record.get("intent");
  if (typeof intent !== "string" || intent.trim() === "") {
    throw new Error(`fixture ${file} must declare a non-empty "intent"`);
  }
  return intent;
}

function jsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".json"))
    .sort();
}

export function loadValid(group: string): ValidFixture[] {
  const dir = join(FIXTURES_DIR, group, "valid");
  return jsonFiles(dir).map((file) => {
    const path = join(dir, file);
    const record = asRecord(JSON.parse(readFileSync(path, "utf8")), path);
    return {
      name: file.replace(/\.json$/, ""),
      intent: requireIntent(record, path),
      value: record.get("value"),
    };
  });
}

export function loadInvalid(group: string): InvalidFixture[] {
  const dir = join(FIXTURES_DIR, group, "invalid");
  return jsonFiles(dir).map((file) => {
    const path = join(dir, file);
    const record = asRecord(JSON.parse(readFileSync(path, "utf8")), path);
    const expected = record.get("expect");
    if (!Array.isArray(expected) || expected.length === 0) {
      throw new Error(`fixture ${path} must declare at least one expected issue`);
    }
    return {
      name: file.replace(/\.json$/, ""),
      intent: requireIntent(record, path),
      expect: expected as readonly ExpectedIssue[],
      value: record.get("value"),
    };
  });
}

export type FixtureFile = { readonly relativePath: string; readonly text: string };

/** Every fixture file in the package, for corpus-wide hygiene checks. */
export function allFixtureFiles(): FixtureFile[] {
  const files: FixtureFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (entry.endsWith(".json")) {
        files.push({ relativePath: relative(REPO_ROOT, path), text: readFileSync(path, "utf8") });
      }
    }
  };
  walk(FIXTURES_DIR);
  return files;
}

/** Depth-first collection of every value stored under `key`. */
export function collectValues(value: unknown, key: string, found: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectValues(item, key, found);
    }
    return found;
  }
  if (typeof value === "object" && value !== null) {
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (entryKey === key) {
        found.push(entryValue);
      }
      collectValues(entryValue, key, found);
    }
  }
  return found;
}
