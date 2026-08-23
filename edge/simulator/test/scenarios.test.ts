import { describe, expect, it } from "vitest";
import { parseScenario, phaseAt, totalTicks } from "../src/scenario.js";
import { loadAllScenarios, loadScenario, scenarioNames } from "../src/scenarios.js";

describe("bundled scenarios", () => {
  it("includes the documented Site 001 situations", () => {
    expect(scenarioNames()).toEqual([
      "battery-bridge",
      "generator-transfer",
      "normal-day",
      "outage-restore",
    ]);
  });

  it("validates every bundled scenario against the schema", () => {
    for (const scenario of loadAllScenarios()) {
      expect(scenario.phases.length).toBeGreaterThan(0);
      expect(scenario.description.length).toBeGreaterThan(20);
      expect(totalTicks(scenario)).toBe(Math.trunc(totalTicks(scenario)));
    }
  });

  it("passes both transfers through a dead interval", () => {
    // The ATS transfer type at Site 001 is unverified, so no scenario may assume a
    // closed-transition switch.
    const sources = loadScenario("generator-transfer").phases.map((phase) => phase.source);
    expect(sources).toEqual(["utility", "none", "generator", "none", "utility"]);
  });

  it("rejects a scenario whose name does not match its filename", () => {
    expect(() => loadScenario("does-not-exist")).toThrow();
  });

  it("rejects an unsafe scenario name rather than touching the filesystem", () => {
    expect(() => loadScenario("../../etc/passwd")).toThrow(/invalid scenario name/);
  });
});

describe("scenario schema", () => {
  /** Deliberately loose: these are candidate JSON documents, not valid scenarios. */
  type JsonPhase = {
    label: string;
    durationMs: number;
    source: string;
    voltage: { mode: string; fraction?: number };
    served: string;
    socRatePctPerHour: number;
  };
  type JsonScenario = {
    name: string;
    description: string;
    intervalMs: number;
    initialSocPct: number;
    phases: JsonPhase[];
  };

  const valid: JsonScenario = {
    name: "probe",
    description: "A scenario used only by tests.",
    intervalMs: 1000,
    initialSocPct: 50,
    phases: [
      {
        label: "steady",
        durationMs: 2000,
        source: "utility",
        voltage: { mode: "nominal" },
        served: "all",
        socRatePctPerHour: 0,
      },
    ],
  };

  function variant(mutate: (phase: JsonPhase) => void): JsonScenario {
    const clone = structuredClone(valid);
    const [phase] = clone.phases;
    if (phase === undefined) {
      throw new Error("fixture has no phase");
    }
    mutate(phase);
    return clone;
  }

  it("accepts a well-formed scenario", () => {
    expect(parseScenario(valid, "probe").phases.length).toBe(1);
  });

  it("requires a sag fraction and forbids it elsewhere", () => {
    const sagWithout = variant((phase) => {
      phase.voltage = { mode: "sag" };
    });
    expect(() => parseScenario(sagWithout, "probe")).toThrow(/fraction is required/);

    const nominalWith = variant((phase) => {
      phase.voltage = { mode: "nominal", fraction: 0.5 };
    });
    expect(() => parseScenario(nominalWith, "probe")).toThrow(/fraction is forbidden/);
  });

  it("requires phase durations to be a whole number of ticks", () => {
    const ragged = variant((phase) => {
      phase.durationMs = 1500;
    });
    expect(() => parseScenario(ragged, "probe")).toThrow(/whole number/);
  });

  it("rejects unknown keys and unknown sources", () => {
    expect(() => parseScenario({ ...valid, extra: true }, "probe")).toThrow();
    const badSource = variant((phase) => {
      phase.source = "mains";
    });
    expect(() => parseScenario(badSource, "probe")).toThrow();
  });
});

describe("phase lookup", () => {
  it("maps ticks onto phases and clamps past the end", () => {
    const scenario = loadScenario("generator-transfer");
    expect(phaseAt(scenario, 0).source).toBe("utility");
    expect(phaseAt(scenario, 89).source).toBe("utility");
    expect(phaseAt(scenario, 90).source).toBe("none");
    expect(phaseAt(scenario, 102).source).toBe("generator");
    expect(phaseAt(scenario, 10_000).source).toBe("utility");
  });
});
