// Wire contract between the phone app, the projector page and the dev-server
// API. Type-only, so both the browser bundle and the server can import it
// without pulling server code into the client.

import type { SuggestResult, Trigger } from '../src/suggest-core.ts';

/**
 * How the phone gets a transcript: Soniox streaming, OpenRouter clips of
 * speech segments (POST /api/transcribe), or neither.
 */
export type SttMode = 'soniox' | 'segments' | 'none';

/** GET /api/config */
export interface ConfigResponse {
  practiceLanguage: string;
  fallbackLanguage: string;
  model: string;
  sttMode: SttMode;
}

/** GET /api/stt-token: a short-lived, single-use Soniox key for the websocket. */
export interface SttTokenResponse {
  apiKey: string;
  expiresAt: string;
}

/**
 * POST /api/transcribe: the request body is one WAV clip (Content-Type
 * audio/wav, at most 1 MB). sttMs is wall time of the upstream call only.
 */
export interface TranscribeResponse {
  text: string;
  sttMs: number;
}

/** POST /api/suggest request body. */
export interface SuggestRequest {
  transcript: string;
  trigger: Trigger;
}

/** POST /api/suggest response. modelMs is wall time of the model call only. */
export interface SuggestResponse {
  result: SuggestResult;
  modelMs: number;
}

export type Phase = 'idle' | 'listening' | 'thinking' | 'suggesting';

/**
 * POST /api/state body, relayed unchanged to /api/events as event 'state'.
 * pauseToHudDispatchMs is pause start to HUD update sent, not physical
 * display latency.
 */
export interface PhoneState {
  transcript: string;
  suggestion: string | null;
  phase: Phase;
  pauseToHudDispatchMs: number | null;
}

/** Every non-2xx response. */
export interface ErrorResponse {
  error: string;
}
