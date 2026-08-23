#!/usr/bin/env node
/**
 * Dependency-free credential scanner.
 *
 * Scans every tracked, staged, and untracked-but-not-ignored file for common
 * credential shapes. Part of the root verification command (`npm run check`) and
 * of CI, because docs/security/threat-model.md makes secret scanning a
 * requirement before the first push, and `CLAUDE.md` prohibits committing
 * credentials outright.
 *
 * Usage:
 *   node scripts/check-secrets.mjs              scan tracked, staged, untracked
 *   node scripts/check-secrets.mjs --self-test  prove every rule still detects
 *   node scripts/check-secrets.mjs --list       list the files that would be scanned
 *
 * Exit codes: 0 clean, 1 findings, 2 scanner error.
 *
 * Suppression: append the marker `secret-check:allow` to a line that a rule
 * matches for a documented, non-credential reason. Suppressions are visible in
 * review, which is the point — there is no configuration file for them.
 *
 * This file excludes itself from scanning, since it necessarily contains the
 * patterns it looks for and the synthetic samples used by --self-test.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

const ALLOW_MARKER = "secret-check:allow";
const MAX_BYTES = 2 * 1024 * 1024;
const SELF = "scripts/check-secrets.mjs";

/** Generated output and dependencies. Source and documentation are always scanned. */
const EXCLUDED_PREFIXES = ["node_modules/", "dist/", "build/", "coverage/", ".git/"];
const EXCLUDED_SUFFIXES = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
  ".ico",
  ".woff",
  ".woff2",
  ".zip",
  ".gz",
  ".db",
  ".sqlite",
];

/**
 * Targeted shapes only. A generic high-entropy rule would fire on lockfile
 * integrity hashes and UUID fixtures, and a scanner people learn to ignore is
 * worse than no scanner.
 */
const RULES = [
  { id: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    id: "aws-secret-access-key",
    pattern: /\baws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/i,
  },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "github-fine-grained-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { id: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "stripe-secret-key", pattern: /\bsk_(?:live|test)_[0-9a-zA-Z]{16,}\b/ },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "openai-api-key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { id: "private-key-block", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { id: "url-embedded-credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]+@/i },
  {
    id: "assigned-credential",
    pattern:
      /\b(?:api[_-]?key|apikey|secret|token|passwd|password|access[_-]?key|client[_-]?secret|private[_-]?key)\s*[:=]\s*["'][^"'\s]{12,}["']/i,
  },
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function repoRoot() {
  return git(["rev-parse", "--show-toplevel"]).trim();
}

function candidateFiles(root) {
  const tracked = git(["ls-files", "-z"]).split("\0");
  const staged = git(["diff", "--cached", "--name-only", "-z"]).split("\0");
  /**
   * Untracked-but-not-ignored files are included deliberately. Scanning only
   * tracked and staged content would pass cleanly on work in progress and then
   * fail the moment it is committed — the check is most useful before the commit,
   * not after. `--exclude-standard` honours .gitignore, so dependencies and
   * generated output are already out of scope.
   */
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0");
  const unique = new Set([...tracked, ...staged, ...untracked].filter((entry) => entry !== ""));

  const files = [];
  for (const path of [...unique].sort()) {
    if (EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) continue;
    if (EXCLUDED_SUFFIXES.some((suffix) => path.toLowerCase().endsWith(suffix))) continue;
    if (path === SELF) continue;

    const absolute = resolve(root, path);
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      // Staged deletion: nothing on disk to scan.
      continue;
    }
    if (!stats.isFile() || stats.size > MAX_BYTES) continue;
    files.push({ path, absolute });
  }
  return files;
}

function redact(match) {
  if (match.length <= 12) return `${match.slice(0, 3)}***`;
  return `${match.slice(0, 6)}***${match.slice(-2)} (${match.length} chars)`;
}

function scanFile(file) {
  const buffer = readFileSync(file.absolute);
  if (buffer.includes(0)) return [];

  const findings = [];
  const lines = buffer.toString("utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.includes(ALLOW_MARKER)) continue;
    for (const rule of RULES) {
      const match = rule.pattern.exec(line);
      if (match !== null) {
        findings.push({
          path: file.path,
          line: index + 1,
          column: match.index + 1,
          rule: rule.id,
          sample: redact(match[0]),
        });
      }
    }
  }
  return findings;
}

/**
 * Synthetic, non-functional samples. Every rule must match its own sample, so a
 * pattern cannot rot into a no-op unnoticed.
 */
const SELF_TEST_SAMPLES = new Map([
  ["aws-access-key-id", ["AKIA", "IOSFODNN7EXAMPLE"].join("")],
  [
    "aws-secret-access-key",
    `aws_secret_access_key = "${["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/")}"`,
  ],
  ["github-token", `ghp_${"A".repeat(36)}`],
  ["github-fine-grained-pat", `github_pat_${"B".repeat(30)}`],
  ["gitlab-token", `glpat-${"C".repeat(24)}`],
  ["slack-token", ["xoxb", "000000000000", "EXAMPLETOKENVALUE"].join("-")],
  ["google-api-key", `AIza${"D".repeat(35)}`],
  ["stripe-secret-key", `sk_live_${"E".repeat(20)}`],
  ["npm-token", `npm_${"F".repeat(36)}`],
  ["anthropic-api-key", `sk-ant-${"G".repeat(24)}`],
  ["openai-api-key", `sk-${"H".repeat(40)}`],
  ["jwt", `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`],
  ["private-key-block", ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ")],
  ["url-embedded-credentials", ["postgresql://user", "hunter2@localhost:5432/db"].join(":")],
  ["assigned-credential", `password = "${["correct", "horse", "battery"].join("")}"`],
]);

function selfTest() {
  const failures = [];
  for (const rule of RULES) {
    const sample = SELF_TEST_SAMPLES.get(rule.id);
    if (sample === undefined) {
      failures.push(`${rule.id}: no self-test sample`);
      continue;
    }
    if (!rule.pattern.test(sample)) {
      failures.push(`${rule.id}: pattern no longer matches its sample`);
    }
  }
  for (const id of SELF_TEST_SAMPLES.keys()) {
    if (!RULES.some((rule) => rule.id === id)) {
      failures.push(`${id}: sample without a rule`);
    }
  }
  // The suppression marker must actually suppress.
  const suppressed = `${["AKIA", "IOSFODNN7EXAMPLE"].join("")} ${ALLOW_MARKER}`;
  if (!suppressed.includes(ALLOW_MARKER)) {
    failures.push("allow marker is not detectable");
  }

  if (failures.length > 0) {
    console.error("secret scanner self-test FAILED");
    for (const failure of failures) console.error(`  - ${failure}`);
    return 2;
  }
  console.log(`secret scanner self-test passed: ${RULES.length} rules`);
  return 0;
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();

  let root;
  try {
    root = repoRoot();
  } catch {
    console.error("secret check: not inside a git repository");
    return 2;
  }

  const files = candidateFiles(root);
  if (argv.includes("--list")) {
    for (const file of files) console.log(relative(".", file.path));
    return 0;
  }

  const findings = files.flatMap(scanFile);
  if (findings.length > 0) {
    console.error(`secret check FAILED: ${findings.length} potential credential(s)`);
    for (const finding of findings) {
      console.error(`  ${finding.path}:${finding.line}:${finding.column}`);
      console.error(`    rule: ${finding.rule}`);
      console.error(`    match: ${finding.sample}`);
    }
    console.error("");
    console.error("Rotate anything real — removing it from history does not un-expose it.");
    console.error(`If this is a documented false positive, append ${ALLOW_MARKER} to the line.`);
    return 1;
  }

  console.log(`secret check passed: ${files.length} files, ${RULES.length} rules`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
