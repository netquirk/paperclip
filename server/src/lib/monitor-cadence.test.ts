// Unit tests for the monitor cadence helper (NET-2045).
//
// The helper is a pure function. The framework never derives the green /
// deploy-confirmed signals — the monitor agent owns those via PATCHes — so
// the tests cover the four acceptance criteria:
//   1. Default policy (no slowdown knobs) returns null (no behavior change).
//   2. slowdownAfterGreens without slowdownCadenceSeconds is rejected at
//      validation; helper stays no-op if either knob is missing.
//   3. Gate is met only when BOTH consecutiveGreens >= slowdownAfterGreens
//      AND deployConfirmed === true; either condition failing returns null.
//   4. computeMonitorNextCheckAt returns now+current when no slowdown, and
//      now+slowdown when the gate engages (NET-1244 target: 5min → 30min).

import { describe, expect, it } from "vitest";

import {
  computeMonitorNextCheckAt,
  resolveMonitorSlowdownCadenceSeconds,
} from "./monitor-cadence.js";
import type {
  IssueExecutionMonitorPolicy,
  IssueExecutionMonitorState,
} from "@paperclipai/shared";

const POLICY_WITH_SLOWDOWN: IssueExecutionMonitorPolicy = {
  nextCheckAt: "2026-08-23T22:00:00.000Z",
  notes: null,
  scheduledBy: "assignee",
  serviceName: "paperclip-routine-cron-shadow-diff",
  slowdownAfterGreens: 3,
  slowdownCadenceSeconds: 1800, // 30 minutes
};

function makeState(overrides: Partial<IssueExecutionMonitorState> = {}): IssueExecutionMonitorState {
  return {
    status: "scheduled",
    nextCheckAt: null,
    lastTriggeredAt: null,
    attemptCount: 0,
    notes: null,
    scheduledBy: "assignee",
    serviceName: null,
    externalRef: null,
    timeoutAt: null,
    maxAttempts: null,
    recoveryPolicy: null,
    clearedAt: null,
    clearReason: null,
    consecutiveGreens: null,
    deployConfirmed: null,
    lastGreenAt: null,
    ...overrides,
  };
}

describe("resolveMonitorSlowdownCadenceSeconds (NET-2045)", () => {
  it("returns null when the policy omits slowdown knobs (default behavior preserved)", () => {
    const policy: IssueExecutionMonitorPolicy = {
      nextCheckAt: "2026-08-23T22:00:00.000Z",
      notes: null,
      scheduledBy: "assignee",
      serviceName: "paperclip-routine-cron-shadow-diff",
    };
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy,
        state: makeState({ consecutiveGreens: 10, deployConfirmed: true }),
      }),
    ).toBeNull();
  });

  it("returns null when policy is null", () => {
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: null,
        state: makeState({ consecutiveGreens: 5, deployConfirmed: true }),
      }),
    ).toBeNull();
  });

  it("returns null when state is null", () => {
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: POLICY_WITH_SLOWDOWN,
        state: null,
      }),
    ).toBeNull();
  });

  it("returns null when consecutiveGreens is below the slowdown threshold", () => {
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: POLICY_WITH_SLOWDOWN,
        state: makeState({ consecutiveGreens: 2, deployConfirmed: true }),
      }),
    ).toBeNull();
  });

  it("returns null when deploy is not confirmed", () => {
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: POLICY_WITH_SLOWDOWN,
        state: makeState({ consecutiveGreens: 5, deployConfirmed: false }),
      }),
    ).toBeNull();
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: POLICY_WITH_SLOWDOWN,
        state: makeState({ consecutiveGreens: 5, deployConfirmed: null }),
      }),
    ).toBeNull();
  });

  it("returns the slowdown cadence when the gate is fully met", () => {
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: POLICY_WITH_SLOWDOWN,
        state: makeState({ consecutiveGreens: 3, deployConfirmed: true }),
      }),
    ).toBe(1800);
  });

  it("engages at exactly the slowdownAfterGreens boundary (off-by-one guard)", () => {
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: POLICY_WITH_SLOWDOWN,
        state: makeState({ consecutiveGreens: 3, deployConfirmed: true }),
      }),
    ).toBe(1800);
  });

  it("ignores a zero / negative slowdownCadenceSeconds", () => {
    expect(
      resolveMonitorSlowdownCadenceSeconds({
        policy: { ...POLICY_WITH_SLOWDOWN, slowdownCadenceSeconds: 0 },
        state: makeState({ consecutiveGreens: 5, deployConfirmed: true }),
      }),
    ).toBeNull();
  });
});

describe("computeMonitorNextCheckAt (NET-2045)", () => {
  const now = new Date("2026-08-23T22:00:00.000Z");

  it("uses the current cadence when the slowdown gate is not met", () => {
    const next = computeMonitorNextCheckAt({
      policy: POLICY_WITH_SLOWDOWN,
      state: makeState({ consecutiveGreens: 1, deployConfirmed: true }),
      currentCadenceSeconds: 300,
      now,
    });
    expect(next.toISOString()).toBe("2026-08-23T22:05:00.000Z");
  });

  it("stretches to the slowdown cadence when the gate is met (NET-1244 target)", () => {
    const next = computeMonitorNextCheckAt({
      policy: POLICY_WITH_SLOWDOWN,
      state: makeState({ consecutiveGreens: 4, deployConfirmed: true }),
      currentCadenceSeconds: 300, // 5 minutes — current NET-1244 cadence
      now,
    });
    expect(next.toISOString()).toBe("2026-08-23T22:30:00.000Z"); // 30 minutes later
  });

  it("falls back to the current cadence when no slowdown policy is set (default monitors unaffected)", () => {
    const policy: IssueExecutionMonitorPolicy = {
      nextCheckAt: "2026-08-23T22:00:00.000Z",
      notes: null,
      scheduledBy: "assignee",
      serviceName: "legacy-monitor",
    };
    const next = computeMonitorNextCheckAt({
      policy,
      state: makeState({ consecutiveGreens: 99, deployConfirmed: true }),
      currentCadenceSeconds: 600,
      now,
    });
    expect(next.toISOString()).toBe("2026-08-23T22:10:00.000Z");
  });
});