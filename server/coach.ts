// The coach's model call: the suggest-core prompt in, a SuggestResult out,
// through a chat-completions API over plain fetch: OpenRouter (operator
// decision 13:50, replacing the Anthropic SDK) or OpenAI directly (14:27, for
// an operator with only an OpenAI key). The two speak the same dialect apart
// from the token-limit field.
//
// OpenRouter fields follow https://openrouter.ai/docs/api-reference (checked
// 2026-10-04): finish_reason is normalised to stop, length, tool_calls,
// content_filter or error, with the provider's own value in
// native_finish_reason, and a choice may carry an error even on HTTP 200.
// OpenAI reports a refusal as message.refusal.

import { buildSuggestPrompt, parseSuggestion, type SuggestResult, type Trigger } from '../src/suggest-core.ts';
import type { ProviderAccess } from './config.ts';
import { OPENAI_API, openAiHeaders } from './openai.ts';
import { OPENROUTER_API, openRouterHeaders, upstreamErrorText } from './openrouter.ts';

export const OPENROUTER_CHAT_URL = `${OPENROUTER_API}/chat/completions`;
export const OPENAI_CHAT_URL = `${OPENAI_API}/chat/completions`;
export const MAX_TOKENS = 256;
// A suggestion later than this is useless on the HUD; fail fast instead.
export const MODEL_TIMEOUT_MS = 10_000;

/** Upstream failure; the message is safe to return to the client (no key). */
export class ModelCallError extends Error {}

export interface SuggestCall {
  transcript: string;
  trigger: Trigger;
  practiceLanguage: string;
  fallbackLanguage: string;
  model: string;
}

export interface ModelAccess extends ProviderAccess {
  fetch: typeof fetch;
  now?: () => number;
}

export const providerLabel = (provider: ProviderAccess['provider']): string => (provider === 'openai' ? 'OpenAI' : 'OpenRouter');

export async function suggest(access: ModelAccess, call: SuggestCall): Promise<{ result: SuggestResult; modelMs: number }> {
  const now = access.now ?? (() => performance.now());
  const prompt = buildSuggestPrompt(call);
  const started = now();
  const openAi = access.provider === 'openai';
  let response: Response;
  try {
    response = await access.fetch(openAi ? OPENAI_CHAT_URL : OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: openAi ? openAiHeaders(access.apiKey) : openRouterHeaders(access.apiKey),
      body: JSON.stringify({
        model: call.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        // OpenAI deprecated max_tokens for max_completion_tokens.
        [openAi ? 'max_completion_tokens' : 'max_tokens']: MAX_TOKENS,
      }),
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ModelCallError(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body: unknown = await response.json().catch(() => null);
  const modelMs = Math.round(now() - started);
  if (!response.ok) throw new ModelCallError(`${providerLabel(access.provider)} answered ${response.status}: ${upstreamErrorText(body)}`);
  return { result: interpret(body), modelMs };
}

interface Completion {
  choices?: Array<{
    finish_reason?: string | null;
    native_finish_reason?: string | null;
    message?: { content?: string | null; refusal?: string | null };
    error?: { code?: number; message?: string };
  }>;
}

export function interpret(body: unknown): SuggestResult {
  const choice = (body as Completion | null)?.choices?.[0];
  if (!choice) throw new ModelCallError(`no choices in response: ${upstreamErrorText(body)}`);
  if (choice.error || choice.finish_reason === 'error') {
    throw new ModelCallError(`model error: ${choice.error?.message ?? 'unspecified'}`);
  }
  // A refusal or filtered reply carries no usable text; the HUD shows nothing.
  if (choice.finish_reason === 'content_filter' || choice.native_finish_reason === 'refusal' || choice.message?.refusal) {
    return { kind: 'abstain' };
  }
  return parseSuggestion(choice.message?.content ?? '');
}
