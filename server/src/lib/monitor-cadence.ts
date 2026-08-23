import type {
  IssueExecutionMonitorPolicy,
  IssueExecutionMonitorState,
} from "@paperclipai/shared";

/**
 * NET-2045: tune the wake cadence of long-lived monitors (e.g. paperclip
 * routine cron-shadow-diff on NET-1244) without forcing every monitor agent
 * to re-derive cadence on each tick. When the operator has set
 * `slowdownAfterGreens` + `slowdownCadenceSeconds` on the monitor policy AND
 * the agent has reported at least that many consecutive greens AND confirmed
 * the underlying deploy is real, the framework returns the reduced cadence so
 * the next reschedule can stretch to e.g. 30 minutes.
 *
 * The framework never mutates the green count or deploy-confirmed flag — the
 * monitor agent owns that signal via PATCHes to `executionState.monitor`.
 * Absence of the slowdown knobs falls through to `null`, which callers treat
 * as "use the existing cadence" (preserves NET-1420-era behavior for every
 * monitor that does not opt in).
 */

export interface ResolveMonitorCadenceInput {
  policy: IssueExecutionMonitorPolicy | null;
  state: IssueExecutionMonitorState | null;
}

/**
 * Returns the slowdown cadence in seconds when every gate is met, else null.
 * - `slowdownAfterGreens` must be set on the policy.
 * - `slowdownCadenceSeconds` must be set and positive on the policy.
 * - `consecutiveGreens` on the state must be `>= slowdownAfterGreens`.
 * - `deployConfirmed` on the state must be `true`.
 *
 * Any missing piece returns `null` so the caller falls back to its existing
 * cadence logic — the default is "no behavior change".
 */
export function resolveMonitorSlowdownCadenceSeconds(
  input: ResolveMonitorCadenceInput,
): number | null {
  const { policy, state } = input;
  if (!policy) return null;
  if (policy.slowdownAfterGreens == null) return null;
  if (policy.slowdownCadenceSeconds == null) return null;
  if (policy.slowdownCadenceSeconds <= 0) return null;
  if (!state) return null;
  if (state.deployConfirmed !== true) return null;
  const greens = state.consecutiveGreens ?? 0;
  if (greens < policy.slowdownAfterGreens) return null;
  return policy.slowdownCadenceSeconds;
}

export interface ComputeMonitorNextCheckAtInput extends ResolveMonitorCadenceInput {
  /** Current cadence the monitor agent already schedules at, in seconds. */
  currentCadenceSeconds: number;
  /** Wall-clock anchor (injected for testability). */
  now: Date;
}

/**
 * Compute the next `monitorNextCheckAt` for a monitor that just observed a
 * green tick. If the slowdown gate is met, returns now + slowdown cadence;
 * otherwise returns now + the existing cadence the agent would have used.
 *
 * The agent still controls cadence decisions — this helper only nudges the
 * reschedule when both the policy opt-in and the agent-confirmed signal line
 * up. Existing monitors ignore it entirely because they neither set the
 * policy knobs nor PATCH the green/deploy state fields.
 */
export function computeMonitorNextCheckAt(input: ComputeMonitorNextCheckAtInput): Date {
  const slowdownSeconds = resolveMonitorSlowdownCadenceSeconds(input);
  const cadenceSeconds = slowdownSeconds ?? input.currentCadenceSeconds;
  return new Date(input.now.getTime() + cadenceSeconds * 1000);
}