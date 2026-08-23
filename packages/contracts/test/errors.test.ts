import { describe, expect, it } from "vitest";
import { safeParseTelemetryBatch } from "../src/batch.js";
import { safeParseTelemetryEnvelope } from "../src/envelope.js";
import { ContractValidationError, formatIssues, formatPath } from "../src/errors.js";

describe("path formatting", () => {
  it("renders object and array segments the way a reader expects", () => {
    expect(formatPath(["readings", 3, "sample", "unit"])).toBe("readings[3].sample.unit");
    expect(formatPath(["origins", 1])).toBe("origins[1]");
    expect(formatPath(["lineage", "inputIds", 0])).toBe("lineage.inputIds[0]");
    expect(formatPath([])).toBe("<root>");
    expect(formatPath([0, "a"])).toBe("[0].a");
  });
});

describe("issue formatting", () => {
  it("prefers a declared domain code over the underlying validator code", () => {
    const issues = formatIssues({
      issues: [
        {
          code: "custom",
          path: ["lineage"],
          message: "lineage is forbidden",
          params: { code: "lineage.forbidden" },
        },
      ],
    });
    expect(issues[0]?.code).toBe("lineage.forbidden");
  });

  it("maps structural validator codes to stable generic codes", () => {
    const issues = formatIssues({
      issues: [{ code: "invalid_type", path: ["origins"], message: "expected array" }],
    });
    expect(issues[0]?.code).toBe("type.invalid");
  });

  it("passes through an unmapped code rather than inventing one", () => {
    const issues = formatIssues({
      issues: [{ code: "brand_new_code", path: ["x"], message: "m" }],
    });
    expect(issues[0]?.code).toBe("brand_new_code");
  });

  it("ignores symbol path segments", () => {
    const issues = formatIssues({
      issues: [{ code: "custom", path: [Symbol("s"), "field"], message: "m" }],
    });
    expect(issues[0]?.path).toBe("field");
  });
});

describe("issue index", () => {
  it("is absent for a standalone envelope", () => {
    const result = safeParseTelemetryEnvelope({ schemaVersion: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    for (const issue of result.issues) {
      expect(issue.index).toBeUndefined();
    }
  });

  it("is present for a failure inside a batch", () => {
    const result = safeParseTelemetryBatch({
      schemaVersion: 1,
      gatewayId: "gw_001_1",
      sequenceStart: 1,
      sequenceEnd: 1,
      clockOffsetMs: 0,
      readings: [{ schemaVersion: 1 }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.length).toBeGreaterThan(0);
    for (const issue of result.issues) {
      expect(issue.index).toBe(0);
      expect(issue.path.startsWith("readings[0]")).toBe(true);
    }
  });
});

describe("ContractValidationError", () => {
  it("summarizes path and code so a log line is actionable", () => {
    const error = new ContractValidationError([
      { path: "origins", segments: ["origins"], code: "origins.empty", message: "empty" },
    ]);
    expect(error.name).toBe("ContractValidationError");
    expect(error.message).toContain("origins");
    expect(error.message).toContain("origins.empty");
    expect(error.issues.length).toBe(1);
  });
});
