// Clip transcription through OpenRouter, for setups without a Soniox account:
// the phone cuts speech segments into WAV clips and posts them here.
//
// Request format per https://openrouter.ai/docs/guides/overview/multimodal/stt
// (checked 2026-10-04): JSON { model, input_audio: { data: base64, format } }.
//
// No `language`: forcing the practice language biases the model to render the
// wearer's slips into their stronger language in the practice language, or to
// drop them, and those slips are what triggers a suggestion (arc-ab8f review,
// 14:36). Auto-detection keeps them. A top-level prompt is "accepted but
// ignored", so the mixed-language hint goes through provider.options, which
// OpenRouter forwards only to the provider serving the request, under that
// provider's own field name: `prompt` for OpenAI (the only endpoint of the
// default model) and Groq (the docs' Whisper example).

import { languageName } from '../src/suggest-core.ts';
import { OPENROUTER_API, openRouterHeaders, upstreamErrorText } from './openrouter.ts';

export const OPENROUTER_TRANSCRIBE_URL = `${OPENROUTER_API}/audio/transcriptions`;
export const TRANSCRIBE_TIMEOUT_MS = 15_000;

/** Upstream failure; the message is safe to return to the client (no key). */
export class TranscribeError extends Error {}

export interface TranscribeCall {
  wav: Uint8Array;
  model: string;
  /** ISO 639-1 codes: the language mostly spoken and the one slipped into. */
  practiceLanguage: string;
  fallbackLanguage: string;
}

export function transcriptionHint(practiceLanguage: string, fallbackLanguage: string): string {
  return [
    `Mostly ${languageName(practiceLanguage)} with occasional ${languageName(fallbackLanguage)} words.`,
    'Write each word in the language it was spoken in.',
    'Keep fillers such as "euh" and "um".',
  ].join(' ');
}

export interface TranscribeAccess {
  apiKey: string;
  fetch: typeof fetch;
  now?: () => number;
}

export async function transcribe(access: TranscribeAccess, call: TranscribeCall): Promise<{ text: string; sttMs: number }> {
  const now = access.now ?? (() => performance.now());
  const hint = transcriptionHint(call.practiceLanguage, call.fallbackLanguage);
  const started = now();
  let response: Response;
  try {
    response = await access.fetch(OPENROUTER_TRANSCRIBE_URL, {
      method: 'POST',
      headers: openRouterHeaders(access.apiKey),
      body: JSON.stringify({
        model: call.model,
        input_audio: { data: Buffer.from(call.wav).toString('base64'), format: 'wav' },
        provider: { options: { openai: { prompt: hint }, groq: { prompt: hint } } },
      }),
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new TranscribeError(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body: unknown = await response.json().catch(() => null);
  const sttMs = Math.round(now() - started);
  if (!response.ok) throw new TranscribeError(`OpenRouter answered ${response.status}: ${upstreamErrorText(body)}`);
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== 'string') throw new TranscribeError(`no text in response: ${upstreamErrorText(body)}`);
  return { text: text.trim(), sttMs };
}

/** RIFF/WAVE container check, so a client bug fails here rather than upstream. */
export function isWav(bytes: Uint8Array): boolean {
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  return bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE';
}
