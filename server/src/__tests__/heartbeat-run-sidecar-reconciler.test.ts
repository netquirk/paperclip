// NET-6944 — Regression tests for the terminal-sidecar reconciler.
//
// These tests exercise the four acceptance criteria from NET-6944:
//   (a) exception from the issue-lock write after run='running'/wake='claimed'
//       → both terminal, agent not left `running`;
//   (b) second invocation proves idempotency;
//   (c) agent with a second queued|running|scheduled_retry run keeps
//       status='running';
//   (d) paused/terminated/pending_approval agents are never rewritten.
//
// The test sets up the post-mortem state directly because simulating a real
// crash between the claim and the terminal run persistence is non-trivial
// without an active executor. The reconciler is the same primitive that
// executes in production, so a direct unit test of its invariants is the
// smallest verification that proves the change.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  reconcileStaleRunSidecars,
  reconcileTerminalRunSidecars,
} from "../services/heartbeat-run-sidecar-reconciler.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping NET-6944 reconciler tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("NET-6944 reconcileTerminalRunSidecars", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-net6944-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // heartbeat_runs.wakeup_request_id references agent_wakeup_requests.id,
    // and heartbeat_runs.agent_id references agents.id. Delete runs first so
    // the FK references are released before their parents are dropped.
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedRun(input: {
    runStatus: "succeeded" | "failed" | "interrupted" | "cancelled" | "timed_out";
    runError?: string | null;
    wakeStatus: "queued" | "claimed" | "deferred_issue_execution" | "completed";
    wakeFinishedAt?: Date | null;
    wakeError?: string | null;
    agentStatus:
      | "active"
      | "paused"
      | "idle"
      | "running"
      | "error"
      | "pending_approval"
      | "terminated";
    agentErrorReason?: string | null;
    extras?: {
      otherLiveRunStatus?: "queued" | "running" | "scheduled_retry";
    };
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const wakeId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: input.agentStatus,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      errorReason: input.agentErrorReason ?? null,
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      runId,
      source: "automation",
      triggerDetail: "system",
      reason: "test_wake",
      status: input.wakeStatus,
      requestedByActorType: "system",
      requestedByActorId: "test",
      finishedAt: input.wakeFinishedAt ?? null,
      error: input.wakeError ?? null,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      wakeupRequestId: wakeId,
      status: input.runStatus,
      invocationSource: "manual",
      error: input.runError ?? null,
      finishedAt: new Date(),
    });
    if (input.extras?.otherLiveRunStatus) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        status: input.extras.otherLiveRunStatus,
        invocationSource: "manual",
      });
    }
    return { companyId, agentId, wakeId, runId };
  }

  // (a) The NET-6942 invariant violation: a terminal run with a `claimed`
  // wake and the owning agent wedged `running`. The reconciler must
  // terminalize the wake to match the run and demote the agent to `idle`
  // without fabricating a `last_heartbeat_at`.
  it("repairs terminal-run + claimed-wake + wedged-running agent", async () => {
    const { runId, wakeId, agentId } = await seedRun({
      runStatus: "succeeded",
      wakeStatus: "claimed",
      agentStatus: "running",
      agentErrorReason: null,
    });

    const outcome = await reconcileTerminalRunSidecars(db, runId);

    expect(outcome.applied).toBe(true);
    expect(outcome.wakeApplied).toBe(true);
    expect(outcome.agentApplied).toBe(true);

    const wake = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId))
      .then((rows) => rows[0]!);
    expect(wake.status).toBe("completed");
    expect(wake.finishedAt).not.toBeNull();
    // The reconciler prefers the run's finishedAt as the source of truth, so
    // it must match the seeded run timestamp rather than wall-clock now().
    const run = await db
      .select({ finishedAt: heartbeatRuns.finishedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);
    expect(wake.finishedAt?.getTime()).toBe(run.finishedAt?.getTime());

    const agent = await db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    expect(agent.status).toBe("idle");
    expect(agent.errorReason).toBeNull();
    // The reconciler must not fabricate a new `last_heartbeat_at`. The agent
    // may already have one (set at seed time), but it must not advance.
    const seededHeartbeatAt = (await db
      .select({ lastHeartbeatAt: agents.lastHeartbeatAt })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!)) as { lastHeartbeatAt: Date | null };
    expect(seededHeartbeatAt.lastHeartbeatAt).toBeNull();
  });

  // (b) A second invocation proves idempotency: the run is already terminal,
  // the wake is already terminal, and the agent is already idle. The
  // primitive must report no work done and not overwrite terminal metadata.
  it("is idempotent on a second invocation", async () => {
    const { runId, wakeId, agentId } = await seedRun({
      runStatus: "succeeded",
      wakeStatus: "claimed",
      agentStatus: "running",
    });

    await reconcileTerminalRunSidecars(db, runId);
    const firstWake = await db
      .select({
        status: agentWakeupRequests.status,
        finishedAt: agentWakeupRequests.finishedAt,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId))
      .then((rows) => rows[0]!);
    const firstAgent = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);

    const second = await reconcileTerminalRunSidecars(db, runId);
    expect(second.applied).toBe(false);
    expect(second.wakeApplied).toBe(false);
    expect(second.agentApplied).toBe(false);
    expect(second.wakeSkippedReason).toBe("wake_already_terminal");
    expect(second.agentSkippedReason).toMatch(/^agent_status_not_running:/);

    const secondWake = await db
      .select({
        status: agentWakeupRequests.status,
        finishedAt: agentWakeupRequests.finishedAt,
        error: agentWakeupRequests.error,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId))
      .then((rows) => rows[0]!);
    const secondAgent = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);

    expect(secondWake).toEqual(firstWake);
    expect(secondAgent).toEqual(firstAgent);
  });

  // (c) The agent already has another live run (queued/running/scheduled_retry)
  // so the reconciler must not demote it. The wake repair still proceeds so
  // handoff/recovery classifiers stop treating the wake as live.
  it("keeps the agent running when a second live run exists", async () => {
    const { runId, wakeId, agentId } = await seedRun({
      runStatus: "succeeded",
      wakeStatus: "claimed",
      agentStatus: "running",
      extras: { otherLiveRunStatus: "queued" },
    });

    const outcome = await reconcileTerminalRunSidecars(db, runId);

    expect(outcome.wakeApplied).toBe(true);
    expect(outcome.agentApplied).toBe(false);
    expect(outcome.agentSkippedReason).toBe("agent_has_other_live_run");

    const wake = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId))
      .then((rows) => rows[0]!);
    expect(wake.status).toBe("completed");

    const agent = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    expect(agent.status).toBe("running");
  });

  // (d) paused/terminated/pending_approval agents are never rewritten. The
  // wake repair still proceeds because the wake is a separate sidecar.
  it.each(["paused", "terminated", "pending_approval"] as const)(
    "never rewrites a %s agent",
    async (protectedStatus) => {
      const { runId, agentId } = await seedRun({
        runStatus: "failed",
        runError: "boom",
        wakeStatus: "claimed",
        agentStatus: protectedStatus,
        agentErrorReason: "previous error",
      });

      const outcome = await reconcileTerminalRunSidecars(db, runId);

      expect(outcome.wakeApplied).toBe(true);
      expect(outcome.agentApplied).toBe(false);
      expect(outcome.agentSkippedReason).toBe(
        `agent_status_protected:${protectedStatus}`,
      );

      const agent = await db
        .select({ status: agents.status, errorReason: agents.errorReason })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0]!);
      expect(agent.status).toBe(protectedStatus);
      expect(agent.errorReason).toBe("previous error");
    },
  );

  // Mapping: terminal run statuses collapse to the corresponding wake
  // statuses. timed_out and interrupted collapse to `failed` because they
  // are not in WAKEUP_REQUEST_STATUSES.
  it.each([
    ["succeeded", "completed"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["timed_out", "failed"],
    ["interrupted", "failed"],
  ] as const)("maps run status %s → wake status %s", async (runStatus, wakeStatus) => {
    const { runId, wakeId } = await seedRun({
      runStatus,
      wakeStatus: "claimed",
      agentStatus: "running",
    });

    const outcome = await reconcileTerminalRunSidecars(db, runId);
    expect(outcome.wakeApplied).toBe(true);

    const wake = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId))
      .then((rows) => rows[0]!);
    expect(wake.status).toBe(wakeStatus);
  });

  // A non-terminal run must not be reconciled. This guards against a
  // regressed caller that hits the primitive before the run reaches a
  // terminal status.
  it("returns run_not_terminal when the run is still running", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const wakeId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      runId,
      source: "automation",
      triggerDetail: "system",
      reason: "test_wake",
      status: "claimed",
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      wakeupRequestId: wakeId,
      status: "running",
      invocationSource: "manual",
    });

    const outcome = await reconcileTerminalRunSidecars(db, runId);
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe("run_not_terminal");

    const wake = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId))
      .then((rows) => rows[0]!);
    expect(wake.status).toBe("claimed");

    const agent = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    expect(agent.status).toBe("running");
  });
});

describeEmbeddedPostgres("NET-6944 reconcileStaleRunSidecars periodic sweep", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-net6944-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    // heartbeat_runs.wakeup_request_id references agent_wakeup_requests.id,
    // and heartbeat_runs.agent_id references agents.id. Delete runs first.
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("repairs both wake and agent in one sweep", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const wakeId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      runId,
      source: "automation",
      triggerDetail: "system",
      reason: "test_wake",
      status: "claimed",
      requestedByActorType: "system",
      requestedByActorId: "test",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      wakeupRequestId: wakeId,
      status: "succeeded",
      invocationSource: "manual",
      finishedAt: new Date(),
    });

    const result = await reconcileStaleRunSidecars(db);
    expect(result.wakeRepaired).toBe(1);
    // Stage 1's reconcileTerminalRunSidecars also demotes the agent because
    // no other live run exists for the agent. The sweep counts that here.
    expect(result.agentRepaired).toBe(1);

    const wake = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId))
      .then((rows) => rows[0]!);
    expect(wake.status).toBe("completed");

    const agent = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    expect(agent.status).toBe("idle");

    // Re-running the sweep is a no-op (idempotency).
    const second = await reconcileStaleRunSidecars(db);
    expect(second.wakeRepaired).toBe(0);
    expect(second.agentRepaired).toBe(0);
  });

  it("demotes an agent with no run at all", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const result = await reconcileStaleRunSidecars(db);
    expect(result.agentRepaired).toBe(1);

    const agent = await db
      .select({ status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
    expect(agent.status).toBe("idle");
  });
});