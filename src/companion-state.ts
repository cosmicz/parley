// The companion displays server state, never guesses a continuation from transcript text.
export type CoachPhase = 'idle' | 'listening' | 'thinking' | 'suggesting';

export interface CoachState {
  transcript: string;
  suggestion: string | null;
  phase: CoachPhase;
  pauseToHudDispatchMs: number | null;
}

const phases = new Set<CoachPhase>(['idle', 'listening', 'thinking', 'suggesting']);

export function resetCoachState(): CoachState {
  return { transcript: '', suggestion: null, phase: 'idle', pauseToHudDispatchMs: null };
}

export function parseCoachState(payload: string): CoachState | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.transcript !== 'string' || !phases.has(candidate.phase as CoachPhase)) return null;
  if (candidate.suggestion !== undefined && candidate.suggestion !== null && typeof candidate.suggestion !== 'string') return null;
  const timing = candidate.pauseToHudDispatchMs;
  if (timing !== undefined && timing !== null && (typeof timing !== 'number' || !Number.isFinite(timing) || timing < 0)) return null;

  return {
    transcript: candidate.transcript,
    suggestion: typeof candidate.suggestion === 'string' ? candidate.suggestion : null,
    phase: candidate.phase as CoachPhase,
    pauseToHudDispatchMs: typeof timing === 'number' ? timing : null,
  };
}

export function reduceCoachState(previous: CoachState, next: CoachState | null): CoachState {
  if (!next) return previous;
  if (next.phase === 'idle') return resetCoachState();
  // Speech has resumed: do not show a suggestion from the preceding pause.
  if (next.phase === 'listening') return { ...next, suggestion: null, pauseToHudDispatchMs: null };
  return next;
}
