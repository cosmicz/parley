// Clip transcription for setups without a Soniox account: the phone cuts
// speech segments into WAV clips and posts them here.
//
// OpenRouter, per https://openrouter.ai/docs/guides/overview/multimodal/stt
// (checked 2026-10-04): JSON { model, input_audio: { data: base64, format } }.
// OpenAI directly: multipart form data with file, model, response_format and
// prompt, built with the global FormData and Blob.
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
import { providerLabel } from './coach.ts';
import type { ProviderAccess } from './config.ts';
import { OPENAI_API, openAiHeaders } from './openai.ts';
import { OPENROUTER_API, openRouterHeaders, upstreamErrorText } from './openrouter.ts';

export const OPENROUTER_TRANSCRIBE_URL = `${OPENROUTER_API}/audio/transcriptions`;
export const OPENAI_TRANSCRIBE_URL = `${OPENAI_API}/audio/transcriptions`;
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
  return `Mostly ${languageName(practiceLanguage)} with occasional ${languageName(fallbackLanguage)} words; write each word in the language spoken; keep fillers like euh and um.`;
}

export interface TranscribeAccess extends ProviderAccess {
  fetch: typeof fetch;
  now?: () => number;
  /** Aborts the request, e.g. when another provider already answered. */
  signal?: AbortSignal;
}

export async function transcribe(access: TranscribeAccess, call: TranscribeCall): Promise<{ text: string; sttMs: number }> {
  const now = access.now ?? (() => performance.now());
  const hint = transcriptionHint(call.practiceLanguage, call.fallbackLanguage);
  const started = now();
  const timeout = AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS);
  const signal = access.signal ? AbortSignal.any([timeout, access.signal]) : timeout;
  let response: Response;
  try {
    response = await access.fetch(
      access.provider === 'openai' ? OPENAI_TRANSCRIBE_URL : OPENROUTER_TRANSCRIBE_URL,
      access.provider === 'openai'
        ? { method: 'POST', headers: openAiHeaders(access.apiKey, false), body: openAiForm(call, hint), signal }
        : {
            method: 'POST',
            headers: openRouterHeaders(access.apiKey),
            body: JSON.stringify({
              model: call.model,
              input_audio: { data: Buffer.from(call.wav).toString('base64'), format: 'wav' },
              provider: { options: { openai: { prompt: hint }, groq: { prompt: hint } } },
            }),
            signal,
          },
    );
  } catch (err) {
    throw new TranscribeError(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body: unknown = await response.json().catch(() => null);
  const sttMs = Math.round(now() - started);
  if (!response.ok) throw new TranscribeError(`${providerLabel(access.provider)} answered ${response.status}: ${upstreamErrorText(body)}`);
  const text = (body as { text?: unknown } | null)?.text;
  if (typeof text !== 'string') throw new TranscribeError(`no text in response: ${upstreamErrorText(body)}`);
  return { text: text.trim(), sttMs };
}

/**
 * Sends the clip to every route at once and returns the first success; the
 * other requests are aborted. Fails only when every route failed.
 */
export function transcribeFirst(
  routes: Array<TranscribeAccess & { model: string }>,
  call: Omit<TranscribeCall, 'model'>,
): Promise<{ text: string; sttMs: number; provider: ProviderAccess['provider'] }> {
  if (routes.length === 0) return Promise.reject(new TranscribeError('no transcription route'));
  const controllers = routes.map(() => new AbortController());
  const failures: string[] = [];
  return new Promise((resolve, reject) => {
    let settled = false;
    routes.forEach((route, i) => {
      transcribe({ ...route, signal: controllers[i].signal }, { ...call, model: route.model }).then(
        (result) => {
          if (settled) return;
          settled = true;
          controllers.forEach((controller, j) => {
            if (j !== i) controller.abort();
          });
          resolve({ ...result, provider: route.provider });
        },
        (err: unknown) => {
          failures.push(`${providerLabel(route.provider)}: ${err instanceof Error ? err.message : String(err)}`);
          if (!settled && failures.length === routes.length) {
            settled = true;
            reject(new TranscribeError(failures.join('; ')));
          }
        },
      );
    });
  });
}

// No language field, for the same reason as above.
function openAiForm(call: TranscribeCall, hint: string): FormData {
  const form = new FormData();
  form.append('file', new Blob([call.wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'clip.wav');
  form.append('model', call.model);
  form.append('response_format', 'json');
  form.append('prompt', hint);
  return form;
}

/** RIFF/WAVE container check, so a client bug fails here rather than upstream. */
export function isWav(bytes: Uint8Array): boolean {
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  return bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE';
}
