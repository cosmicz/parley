// Server configuration from the environment Vite loads (.env, .env.local and
// the process environment). Keys live here only; nothing in this module is
// imported by the client bundle.

import type { ConfigResponse, Provider, SttMode } from './contract.ts';

export interface ServerConfig extends Omit<ConfigResponse, 'sttMode'> {
  /** Model id for POST /api/transcribe, in the provider's own naming. */
  transcribeModel: string;
  sonioxApiKey?: string;
  openRouterApiKey?: string;
  openAiApiKey?: string;
}

export type ProviderAccess = { provider: Exclude<Provider, 'none'>; apiKey: string };

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

// OpenRouter model ids are vendor-prefixed ("anthropic/claude-haiku-4.5");
// OpenAI's are bare. A slug left in COACH_MODEL must not reach OpenAI.
const isOpenRouterSlug = (model: string | undefined): boolean => model?.includes('/') ?? false;

export function readConfig(env: Record<string, string | undefined>): ServerConfig {
  const openRouterApiKey = nonEmpty(env.OPENROUTER_API_KEY);
  const openAiApiKey = nonEmpty(env.OPENAI_API_KEY);
  const provider: Provider = openRouterApiKey ? 'openrouter' : openAiApiKey ? 'openai' : 'none';
  const coachModel = nonEmpty(env.COACH_MODEL);
  const transcribeModel = nonEmpty(env.TRANSCRIBE_MODEL);
  const openAi = provider === 'openai';
  return {
    practiceLanguage: nonEmpty(env.PRACTICE_LANGUAGE) ?? 'fr',
    fallbackLanguage: nonEmpty(env.FALLBACK_LANGUAGE) ?? 'en',
    provider,
    // OpenRouter defaults were listed in its public model list 2026-10-04
    // (pahax-6ws, pahax-t37). gpt-4.1-mini is a non-reasoning model, for latency.
    model: openAi
      ? (nonEmpty(env.OPENAI_COACH_MODEL) ?? (isOpenRouterSlug(coachModel) ? undefined : coachModel) ?? 'gpt-4.1-mini')
      : (coachModel ?? 'anthropic/claude-haiku-4.5'),
    transcribeModel: openAi
      // Measured live 14:58 on a 3.6 s French clip: gpt-4o-transcribe 1.3-2.0 s and
      // accurate; gpt-4o-mini-transcribe 4.4-4.8 s; whisper-1 1.6-1.8 s but mangles fillers.
      ? ((isOpenRouterSlug(transcribeModel) ? undefined : transcribeModel) ?? 'gpt-4o-transcribe')
      : (transcribeModel ?? 'openai/gpt-4o-mini-transcribe'),
    sonioxApiKey: nonEmpty(env.SONIOX_API_KEY),
    openRouterApiKey,
    openAiApiKey,
  };
}

/** The selected provider and its key, or null when neither key is set. */
export function providerAccess(config: ServerConfig): ProviderAccess | null {
  if (config.provider === 'openrouter' && config.openRouterApiKey) return { provider: 'openrouter', apiKey: config.openRouterApiKey };
  if (config.provider === 'openai' && config.openAiApiKey) return { provider: 'openai', apiKey: config.openAiApiKey };
  return null;
}

/** The public view of the config; never includes keys. */
export function publicConfig(config: ServerConfig): ConfigResponse {
  return {
    practiceLanguage: config.practiceLanguage,
    fallbackLanguage: config.fallbackLanguage,
    model: config.model,
    provider: config.provider,
    sttMode: sttMode(config),
  };
}

/** Soniox streaming wins when both keys are present. */
export function sttMode(config: ServerConfig): SttMode {
  if (config.sonioxApiKey) return 'soniox';
  if (providerAccess(config)) return 'segments';
  return 'none';
}
