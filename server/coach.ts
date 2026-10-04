// The coach's model call: the suggest-core prompt in, a SuggestResult out.
//
// The Anthropic SDK is imported for types only. The real client is loaded with
// a dynamic import inside createAnthropicClient, so tests and every route other
// than a live /api/suggest never execute SDK code.

import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { buildSuggestPrompt, parseSuggestion, type SuggestResult, type Trigger } from '../src/suggest-core.ts';

export const MAX_TOKENS = 256;

/** The slice of the Anthropic client this server uses; tests supply a fake. */
export interface MessagesClient {
  messages: {
    create(params: MessageCreateParamsNonStreaming): Promise<ModelReply>;
  };
}

export interface ModelReply {
  content: ReadonlyArray<{ type: string; text?: string }>;
  stop_reason: string | null;
}

export interface SuggestCall {
  transcript: string;
  trigger: Trigger;
  practiceLanguage: string;
  fallbackLanguage: string;
  model: string;
}

export async function suggest(
  client: MessagesClient,
  call: SuggestCall,
  now: () => number = () => performance.now(),
): Promise<{ result: SuggestResult; modelMs: number }> {
  const prompt = buildSuggestPrompt(call);
  const started = now();
  const reply = await client.messages.create({
    model: call.model,
    max_tokens: MAX_TOKENS,
    system: prompt.system,
    messages: [{ role: 'user', content: prompt.user }],
  });
  const modelMs = Math.round(now() - started);
  return { result: interpret(reply), modelMs };
}

export function interpret(reply: ModelReply): SuggestResult {
  // A refusal carries no usable text; the HUD shows nothing rather than an error.
  if (reply.stop_reason === 'refusal') return { kind: 'abstain' };
  const text = reply.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
  return parseSuggestion(text);
}

/** Lazily constructs one real SDK client on first use. */
export function createAnthropicClient(apiKey: string): () => Promise<MessagesClient> {
  let client: Promise<MessagesClient> | undefined;
  return () => {
    client ??= import('@anthropic-ai/sdk').then(({ default: Anthropic }) => {
      const sdk = new Anthropic({ apiKey });
      return { messages: { create: (params) => sdk.messages.create(params) } } satisfies MessagesClient;
    });
    // A failed load is not cached, so the next request retries it.
    client.catch(() => {
      client = undefined;
    });
    return client;
  };
}
