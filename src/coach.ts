// Parley's decision core, free of I/O so it can be tested without glasses.
//
// Inputs: transcript updates, pause/resume events from the VAD, temple taps,
// suggestion results and HUD dispatch confirmations. Outputs: effects for the
// wiring layer to perform. Every request carries a sequence number; any newer
// speech or request invalidates older ones, so a late answer never appears
// after the wearer has moved on.

import type { VadEvent } from './vad.ts';
import type { SuggestResult, Trigger } from './suggest-core.ts';

export type Phase = 'idle' | 'listening' | 'thinking' | 'suggesting';

/** Also the SSE 'state' payload the projector page renders. */
export interface CoachState {
  transcript: string;
  suggestion: string | null;
  phase: Phase;
  /** App-side: silence start to the moment the HUD update was dispatched. */
  pauseToHudDispatchMs: number | null;
}

export type CoachEffect =
  | { type: 'request'; seq: number; trigger: Trigger; transcript: string }
  | { type: 'show-suggestion'; seq: number | null; text: string }
  | { type: 'publish' };

const initialState = (): CoachState => ({ transcript: '', suggestion: null, phase: 'idle', pauseToHudDispatchMs: null });

export interface CoachOptions {
  /**
   * Clip transcription: the utterance's text arrives only after the pause, so
   * a pause or tap waits for the next transcript before requesting.
   */
  waitForTranscript?: boolean;
}

export class Coach {
  state: CoachState = initialState();
  private seq = 0;
  private pending: { seq: number; startedAt: number } | null = null;
  private awaiting: { trigger: Trigger; startedAt: number } | null = null;
  private readonly waitForTranscript: boolean;

  constructor(options: CoachOptions = {}) {
    this.waitForTranscript = options.waitForTranscript ?? false;
  }

  onTranscript(text: string): CoachEffect[] {
    this.state.transcript = text;
    if (this.state.phase === 'idle' && text.trim()) this.state.phase = 'listening';
    if (this.awaiting) {
      const { trigger, startedAt } = this.awaiting;
      this.awaiting = null;
      const effects = this.request(trigger, startedAt);
      if (effects.length > 0) return effects;
      this.state.phase = text.trim() ? 'listening' : 'idle';
    }
    return [{ type: 'publish' }];
  }

  onVad(event: VadEvent, nowMs: number): CoachEffect[] {
    if (event.kind === 'pause') {
      // The pause fires after the silence threshold; date the request from the
      // moment the silence began.
      const silenceStartedAt = nowMs - (event.atMs - event.silenceStartedAtMs);
      return this.waitForTranscript ? this.await('pause', silenceStartedAt) : this.request('pause', silenceStartedAt);
    }
    // Speech started or resumed: anything pending or awaited is stale.
    this.seq += 1;
    this.pending = null;
    this.awaiting = null;
    const effects: CoachEffect[] = [];
    if (this.state.suggestion !== null) {
      this.state.suggestion = null;
      effects.push({ type: 'show-suggestion', seq: null, text: '' });
    }
    this.state.phase = 'listening';
    effects.push({ type: 'publish' });
    return effects;
  }

  onHelp(nowMs: number): CoachEffect[] {
    return this.waitForTranscript ? this.await('tap', nowMs) : this.request('tap', nowMs);
  }

  onSuggestion(seq: number, result: SuggestResult): CoachEffect[] {
    if (!this.pending || seq !== this.pending.seq) return [];
    if (result.kind === 'suggestion') {
      this.state.suggestion = result.text;
      this.state.phase = 'suggesting';
      return [{ type: 'show-suggestion', seq, text: result.text }, { type: 'publish' }];
    }
    this.pending = null;
    this.state.phase = 'listening';
    return [{ type: 'publish' }];
  }

  onDispatched(seq: number, nowMs: number): CoachEffect[] {
    if (!this.pending || seq !== this.pending.seq) return [];
    this.state.pauseToHudDispatchMs = Math.round(nowMs - this.pending.startedAt);
    this.pending = null;
    return [{ type: 'publish' }];
  }

  reset(): CoachEffect[] {
    this.seq += 1;
    this.pending = null;
    this.awaiting = null;
    this.state = initialState();
    return [{ type: 'show-suggestion', seq: null, text: '' }, { type: 'publish' }];
  }

  private await(trigger: Trigger, startedAt: number): CoachEffect[] {
    this.seq += 1;
    this.pending = null;
    this.awaiting = { trigger, startedAt };
    this.state.phase = 'thinking';
    return [{ type: 'publish' }];
  }

  private request(trigger: Trigger, startedAt: number): CoachEffect[] {
    if (!this.state.transcript.trim()) return [];
    this.seq += 1;
    this.pending = { seq: this.seq, startedAt };
    this.state.phase = 'thinking';
    return [{ type: 'request', seq: this.seq, trigger, transcript: this.state.transcript }, { type: 'publish' }];
  }
}
