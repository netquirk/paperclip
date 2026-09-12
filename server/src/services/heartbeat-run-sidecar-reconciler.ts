// NET-6944 — Terminal-sidecar reconciler.
//
// Split-finalization invariant gap: `claimQueuedRun()` in heartbeat.ts can flip
// `heartbeat_runs.status` to "running" and the linked `agent_wakeup_requests`
// to "claimed" before any cleanup boundary exists. If a later write throws
// (most commonly the `issues.executionRunId` unique-index exception raised by
// NET-6788 / NET-3885), the run is terminal later but the wake stays
// `claimed` and the agent stays `running` forever. Recovery-classifier paths
// treat stale `claimed` wakes as live and can suppress legitimate recovery.
//
// This module is the shared primitive called from every terminalization path
// (executeRun's outer finally, reapOrphanedRuns, sweepStaleIssueLocks, and
// the periodic sweep). It is idempotent, transaction-wrapped, and never
// overwrites terminal sidecar metadata. The weekly sweep `reconcileStaleRun-
// Sidecars` is bounded and idempotent so it is safe to invoke on a timer or at
// startup.
//
// Sidecars touched: `agent_wakeup_requests` (status, finished_at, error) and
// `agents.status` (idle without fabricating a new `last_heartbeat_at`).
import { and, desc, eq, inArray, isNotNull, ne, notExists, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  heartbeatRuns,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";

export const HEARTBEAT_RUN_TERMINAL_STATUSES = [
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type HeartbeatRunTerminalStatus =
  (typeof HEARTBEAT_RUN_TERMINAL_STATUSES)[number];

export function isHeartbeatRunTerminalStatus(
  status: string | null | undefined,
): status is HeartbeatRunTerminalStatus {
  return (
    typeof status === "string" &&
    (HEARTBEAT_RUN_TERMINAL_STATUSES as readonly string[]).includes(status)
  );
}

const TERMINAL_RUN_WAKE_STATUSES = new Set([
  "completed",
  "cancelled",
  "failed",
]);

const TERMINAL_SIDECAR_AGENT_PROTECTED_STATUSES = new Set([
  "paused",
  "terminated",
  "pending_approval",
]);

// Live wake statuses that may be rewritten by the reconciler. Terminal wake
// statuses (skipped, coalesced, completed, failed, cancelled) are never
// overwritten — that would erase manual annotations or recovery metadata.
const LIVE_WAKE_STATUSES_FOR_RECONCILIATION = [
  "queued",
  "deferred_issue_execution",
  "claimed",
] as const;

// Map a terminal heartbeat run status to the corresponding wake status. Run
// statuses that are not in WAKEUP_REQUEST_STATUSES (timed_out, interrupted)
// collapse to "failed" so the wake row carries the precise run error without
// losing its terminal shape.
function mapRunStatusToWakeupStatus(
  runStatus: string,
): "completed" | "cancelled" | "failed" | null {
  if (runStatus === "succeeded") return "completed";
  if (runStatus === "cancelled") return "cancelled";
  if (
    runStatus === "failed" ||
    runStatus === "timed_out" ||
    runStatus === "interrupted"
  ) {
    return "failed";
  }
  return null;
}

export type ReconcileTerminalRunSidecarsOutcome = {
  applied: boolean;
  reason?: string;
  runStatus?: string;
  wakeApplied?: boolean;
  wakeSkippedReason?: string | null;
  agentApplied?: boolean;
  agentSkippedReason?: string | null;
};

/**
 * Reconcile a terminal heartbeat run with its sidecar rows
 * (`agent_wakeup_requests` + `agents.status`). Idempotent: every write is
 * guarded by current state, so concurrent finalizers and process restarts
 * can call it freely without losing the original terminal outcome.
 *
 * - Wake row: written only while the wake is still in a live status
 *   (`queued` / `deferred_issue_execution` / `claimed`); never overwrites an
 *   already-terminal wake. The terminal wake status is mapped from the
 *   terminal run status; `finished_at` and `error` preserve any value that
 *   another path already wrote.
 * - Agent row: written only while `status='running'` AND no other live
 *   (`queued|running|scheduled_retry`) run exists for the agent. Paused,
 *   terminated, and pending_approval agents are never rewritten. The
 *   transition drops `error_reason` but does not fabricate a new
 *   `last_heartbeat_at` — that timestamp belongs to the run that last
 *   executed, which is recorded on the run row.
 *
 * The whole primitive runs in a single DB transaction so a crash between
 * the wake write and the agent write cannot leave them out of sync.
 */
export async function reconcileTerminalRunSidecars(
  db: Db,
  runId: string,
): Promise<ReconcileTerminalRunSidecarsOutcome> {
  const run = await db
    .select()
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null);
  if (!run) {
    return { applied: false, reason: "missing_run" };
  }
  if (!isHeartbeatRunTerminalStatus(run.status)) {
    return { applied: false, reason: "run_not_terminal" };
  }

  const wakeStatus = mapRunStatusToWakeupStatus(run.status);
  const fallbackFinishedAt = run.finishedAt ?? new Date();
  const runError = run.error
    ? run.error
    : run.errorCode
      ? `${run.errorCode}`
      : null;

  return db.transaction(async (tx) => {
    const liveWake = run.wakeupRequestId
      ? await tx
          .select({
            id: agentWakeupRequests.id,
            status: agentWakeupRequests.status,
            finishedAt: agentWakeupRequests.finishedAt,
            error: agentWakeupRequests.error,
          })
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, run.wakeupRequestId))
          .then((rows) => rows[0] ?? null)
      : null;

    let wakeApplied = false;
    let wakeSkippedReason: string | null = null;
    if (liveWake && wakeStatus) {
      if (
        LIVE_WAKE_STATUSES_FOR_RECONCILIATION.includes(
          liveWake.status as (typeof LIVE_WAKE_STATUSES_FOR_RECONCILIATION)[number],
        )
      ) {
        const updated = await tx
          .update(agentWakeupRequests)
          .set({
            status: wakeStatus,
            finishedAt:
              liveWake.finishedAt ?? run.finishedAt ?? fallbackFinishedAt,
            error: liveWake.error ?? runError,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agentWakeupRequests.id, liveWake.id),
              inArray(agentWakeupRequests.status, [
                ...LIVE_WAKE_STATUSES_FOR_RECONCILIATION,
              ]),
            ),
          )
          .returning({ id: agentWakeupRequests.id })
          .then((rows) => rows[0] ?? null);
        wakeApplied = Boolean(updated);
        if (!updated) wakeSkippedReason = "wake_write_lost_cas";
      } else if (TERMINAL_RUN_WAKE_STATUSES.has(liveWake.status)) {
        wakeSkippedReason = "wake_already_terminal";
      } else {
        // wake is in skipped/coalesced — preserve that terminal annotation.
        wakeSkippedReason = "wake_already_terminal_non_failed";
      }
    }

    const agent = await tx
      .select({
        id: agents.id,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, run.agentId))
      .then((rows) => rows[0] ?? null);

    let agentApplied = false;
    let agentSkippedReason: string | null = null;
    if (!agent) {
      agentSkippedReason = "agent_missing";
    } else if (TERMINAL_SIDECAR_AGENT_PROTECTED_STATUSES.has(agent.status)) {
      agentSkippedReason = `agent_status_protected:${agent.status}`;
    } else if (agent.status !== "running") {
      agentSkippedReason = `agent_status_not_running:${agent.status}`;
    } else {
      // The agent is `running`; only demote to `idle` when no other live
      // run exists. queued/running/scheduled_retry all count as live so a
      // genuine concurrent run is never starved.
      const [{ liveRunCount }] = await tx
        .select({
          liveRunCount: sql<number>`count(*)::int`,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, run.agentId),
            ne(heartbeatRuns.id, run.id),
            inArray(heartbeatRuns.status, [
              "queued",
              "running",
              "scheduled_retry",
            ]),
          ),
        );
      if (Number(liveRunCount ?? 0) > 0) {
        agentSkippedReason = "agent_has_other_live_run";
      } else {
        const updatedAgent = await tx
          .update(agents)
          .set({
            status: "idle",
            errorReason: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(agents.id, agent.id),
              eq(agents.status, "running"),
              // Defense-in-depth: refuse to repaint an agent that just
              // picked up a new live run while this transaction was open.
              // The NOT EXISTS check above already runs inside the
              // transaction, so this guard is just the compare-and-set.
            ),
          )
          .returning({ id: agents.id, status: agents.status })
          .then((rows) => rows[0] ?? null);
        if (updatedAgent) {
          agentApplied = true;
          publishLiveEvent({
            companyId: run.companyId,
            type: "agent.status",
            payload: {
              agentId: updatedAgent.id,
              status: updatedAgent.status,
              lastHeartbeatAt: null,
              outcome: run.status,
            },
          });
        } else {
          agentSkippedReason = "agent_write_lost_cas";
        }
      }
    }

    return {
      applied: wakeApplied || agentApplied,
      runStatus: run.status,
      wakeApplied,
      wakeSkippedReason,
      agentApplied,
      agentSkippedReason,
    };
  });
}

/**
 * Periodic / startup sweep: repair terminal-run ↔ live-wake mismatches and
 * any agent stuck `running` without a live run. Bounded and idempotent so
 * it can run on a timer and on boot. Returns counts only; callers log or
 * act on the result.
 */
export async function reconcileStaleRunSidecars(
  db: Db,
  input?: { limit?: number; companyId?: string },
): Promise<{
  scanned: number;
  wakeRepaired: number;
  agentRepaired: number;
}> {
  const limit = Math.max(1, Math.min(input?.limit ?? 200, 1000));
  const companyId = input?.companyId ?? null;

  // Stage 1: every terminal run whose wake is still in a live status.
  const staleWakeRunRows = await db
    .select({
      runId: heartbeatRuns.id,
      agentId: heartbeatRuns.agentId,
      companyId: heartbeatRuns.companyId,
      wakeupRequestId: heartbeatRuns.wakeupRequestId,
      runStatus: heartbeatRuns.status,
    })
    .from(heartbeatRuns)
    .innerJoin(
      agentWakeupRequests,
      eq(agentWakeupRequests.id, heartbeatRuns.wakeupRequestId),
    )
    .where(
      and(
        isNotNull(heartbeatRuns.wakeupRequestId),
        companyId ? eq(heartbeatRuns.companyId, companyId) : undefined,
        inArray(heartbeatRuns.status, [
          "succeeded",
          "interrupted",
          "failed",
          "cancelled",
          "timed_out",
        ]),
        inArray(agentWakeupRequests.status, [
          "queued",
          "deferred_issue_execution",
          "claimed",
        ]),
      ),
    )
    .limit(limit);

  let wakeRepaired = 0;
  let agentRepaired = 0;
  for (const row of staleWakeRunRows) {
    try {
      const outcome = await reconcileTerminalRunSidecars(db, row.runId);
      if (outcome.wakeApplied) wakeRepaired += 1;
      // Stage 1's reconcileTerminalRunSidecars also demotes the agent if
      // appropriate. Count that as an agent repair so the caller can report
      // both wake and agent progress from a single sweep.
      if (outcome.agentApplied) agentRepaired += 1;
    } catch (err) {
      logger.warn(
        { err, runId: row.runId },
        "periodic reconcile: terminal-run ↔ live-wake repair failed",
      );
    }
  }

  // Stage 2: agents stuck `running` with no live run.
  const stuckAgents = await db
    .select({
      agentId: agents.id,
      companyId: agents.companyId,
    })
    .from(agents)
    .where(
      and(
        eq(agents.status, "running"),
        companyId ? eq(agents.companyId, companyId) : undefined,
        notExists(
          db
            .select({ id: sql`1` })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.agentId, agents.id),
                inArray(heartbeatRuns.status, [
                  "queued",
                  "running",
                  "scheduled_retry",
                ]),
              ),
            ),
        ),
      ),
    )
    .limit(limit);

  for (const stuck of stuckAgents) {
    try {
      const recentTerminalRun = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, stuck.agentId))
        .orderBy(
          desc(heartbeatRuns.finishedAt),
          desc(heartbeatRuns.updatedAt),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (recentTerminalRun) {
        const outcome = await reconcileTerminalRunSidecars(
          db,
          recentTerminalRun.id,
        );
        if (outcome.agentApplied) agentRepaired += 1;
        continue;
      }

      const updated = await db
        .update(agents)
        .set({
          status: "idle",
          errorReason: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(agents.id, stuck.agentId),
            eq(agents.status, "running"),
          ),
        )
        .returning({ id: agents.id, status: agents.status })
        .then((rows) => rows[0] ?? null);
      if (updated) {
        agentRepaired += 1;
        publishLiveEvent({
          companyId: stuck.companyId,
          type: "agent.status",
          payload: {
            agentId: updated.id,
            status: updated.status,
            lastHeartbeatAt: null,
            outcome: "stuck_running_recovered",
          },
        });
      }
    } catch (err) {
      logger.warn(
        { err, agentId: stuck.agentId },
        "periodic reconcile: stuck-running agent repair failed",
      );
    }
  }

  return {
    scanned: staleWakeRunRows.length + stuckAgents.length,
    wakeRepaired,
    agentRepaired,
  };
}