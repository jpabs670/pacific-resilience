import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseScenario, type Scenario } from "./scenario.js";

/** Bundled scenario files. Reading them is a boundary, so each one is validated. */

const SCENARIOS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "scenarios");

export function scenarioNames(): string[] {
  return readdirSync(SCENARIOS_DIR)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => entry.replace(/\.json$/, ""))
    .sort();
}

export function loadScenario(name: string): Scenario {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`invalid scenario name: ${JSON.stringify(name)}`);
  }
  const path = join(SCENARIOS_DIR, `${name}.json`);
  const scenario = parseScenario(JSON.parse(readFileSync(path, "utf8")), path);
  if (scenario.name !== name) {
    throw new Error(`scenario ${path} declares name "${scenario.name}"`);
  }
  return scenario;
}

export function loadAllScenarios(): Scenario[] {
  return scenarioNames().map((name) => loadScenario(name));
}
