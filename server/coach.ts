// The coach's model call: the suggest-core prompt in, a SuggestResult out,
// through OpenRouter's chat-completions API over plain fetch (operator
// decision 13:50, replacing the Anthropic SDK; no client package needed).
//
// Request and response fields follow https://openrouter.ai/docs/api-reference
// (checked 2026-10-04): finish_reason is normalised to stop, length,
// tool_calls, content_filter or error, with the provider's own value in
// native_finish_reason, and a choice may carry an error even on HTTP 200.

import { buildSuggestPrompt, parseSuggestion, type SuggestResult, type Trigger } from '../src/suggest-core.ts';

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const MAX_TOKENS = 256;
// A suggestion later than this is useless on the HUD; fail fast instead.
export const MODEL_TIMEOUT_MS = 10_000;
const APP_TITLE = 'Parley';

/** Upstream failure; the message is safe to return to the client (no key). */
export class ModelCallError extends Error {}

export interface SuggestCall {
  transcript: string;
  trigger: Trigger;
  practiceLanguage: string;
  fallbackLanguage: string;
  model: string;
}

export interface ModelAccess {
  apiKey: string;
  fetch: typeof fetch;
  now?: () => number;
}

export async function suggest(access: ModelAccess, call: SuggestCall): Promise<{ result: SuggestResult; modelMs: number }> {
  const now = access.now ?? (() => performance.now());
  const prompt = buildSuggestPrompt(call);
  const started = now();
  let response: Response;
  try {
    response = await access.fetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access.apiKey}`,
        'Content-Type': 'application/json',
        'X-OpenRouter-Title': APP_TITLE,
      },
      body: JSON.stringify({
        model: call.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        max_tokens: MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ModelCallError(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body: unknown = await response.json().catch(() => null);
  const modelMs = Math.round(now() - started);
  if (!response.ok) throw new ModelCallError(`OpenRouter answered ${response.status}: ${errorText(body)}`);
  return { result: interpret(body), modelMs };
}

interface Completion {
  choices?: Array<{
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    message?: { content?: string | null };
    error?: { code?: number; message?: string };
  }>;
}

export function interpret(body: unknown): SuggestResult {
  const choice = (body as Completion | null)?.choices?.[0];
  if (!choice) throw new ModelCallError(`no choices in response: ${errorText(body)}`);
  if (choice.error || choice.finish_reason === 'error') {
    throw new ModelCallError(`model error: ${choice.error?.message ?? 'unspecified'}`);
  }
  // A refusal or filtered reply carries no usable text; the HUD shows nothing.
  if (choice.finish_reason === 'content_filter' || choice.native_finish_reason === 'refusal') return { kind: 'abstain' };
  return parseSuggestion(choice.message?.content ?? '');
}

function errorText(body: unknown): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === 'string' ? message : 'no error message';
}
