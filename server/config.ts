// Server configuration from the environment Vite loads (.env, .env.local and
// the process environment). Keys live here only; nothing in this module is
// imported by the client bundle.

import type { ConfigResponse, Provider, SttMode } from './contract.ts';

export interface ServerConfig extends Omit<ConfigResponse, 'sttMode'> {
  /** Model id for POST /api/transcribe, in the transcription provider's naming. */
  transcribeModel: string;
  /** OpenRouter's model when both keys are set and transcription races both. */
  openRouterTranscribeModel?: string;
  /**
   * Transcription prefers OpenAI direct whenever its key is set: live at 15:23
   * the same clip took 7.7-8.2 s through OpenRouter vs 2.1 s direct (arc-7qwo).
   */
  transcribeProvider: Provider;
  sonioxApiKey?: string;
  openRouterApiKey?: string;
  openAiApiKey?: string;
  /** REALTIME_STT=1: stream to OpenAI realtime transcription (spike, pahax-g2x). */
  realtimeStt: boolean;
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
  const transcribeProvider: Provider = openAiApiKey ? 'openai' : provider;
  return {
    practiceLanguage: nonEmpty(env.PRACTICE_LANGUAGE) ?? 'fr',
    fallbackLanguage: nonEmpty(env.FALLBACK_LANGUAGE) ?? 'en',
    provider,
    // OpenRouter defaults were listed in its public model list 2026-10-04
    // (pahax-6ws, pahax-t37). gpt-4.1-mini is a non-reasoning model, for latency.
    model: openAi
      ? (nonEmpty(env.OPENAI_COACH_MODEL) ?? (isOpenRouterSlug(coachModel) ? undefined : coachModel) ?? 'gpt-4.1-mini')
      : (coachModel ?? 'anthropic/claude-haiku-4.5'),
    transcribeProvider,
    transcribeModel: transcribeProvider === 'openai'
      // Measured live 14:58 on a 3.6 s French clip: gpt-4o-transcribe 1.3-2.0 s and
      // accurate; gpt-4o-mini-transcribe 4.4-4.8 s; whisper-1 1.6-1.8 s but mangles fillers.
      ? ((isOpenRouterSlug(transcribeModel) ? undefined : transcribeModel) ?? 'gpt-4o-transcribe')
      // Live via OpenRouter 15:16: openai/gpt-4o-transcribe 1.2-2.0 s, accurate;
      // openai/gpt-4o-mini-transcribe 2.3-2.8 s and turned "euh" into "you"/"U.".
      : (transcribeModel ?? 'openai/gpt-4o-transcribe'),
    openRouterTranscribeModel: isOpenRouterSlug(transcribeModel)
      ? transcribeModel
      : `openai/${transcribeModel ?? 'gpt-4o-transcribe'}`,
    sonioxApiKey: nonEmpty(env.SONIOX_API_KEY),
    openRouterApiKey,
    openAiApiKey,
    realtimeStt: nonEmpty(env.REALTIME_STT) === '1',
  };
}

/** The selected provider and its key, or null when neither key is set. */
export function providerAccess(config: ServerConfig): ProviderAccess | null {
  if (config.provider === 'openrouter' && config.openRouterApiKey) return { provider: 'openrouter', apiKey: config.openRouterApiKey };
  if (config.provider === 'openai' && config.openAiApiKey) return { provider: 'openai', apiKey: config.openAiApiKey };
  return null;
}

/** Access for POST /api/transcribe: OpenAI direct when its key is set. */
export function transcribeAccess(config: ServerConfig): ProviderAccess | null {
  if (config.transcribeProvider === 'openai' && config.openAiApiKey) return { provider: 'openai', apiKey: config.openAiApiKey };
  return providerAccess(config);
}

export type TranscribeRoute = ProviderAccess & { model: string };

/**
 * Where POST /api/transcribe sends a clip. With both keys, OpenAI direct and
 * OpenRouter race (pahax-k4s): live latency on either swung from under 1 s to
 * over 10 s at 15:45, so the first success wins.
 */
export function transcribeRoutes(config: ServerConfig): TranscribeRoute[] {
  if (config.openAiApiKey && config.openRouterApiKey) {
    return [
      { provider: 'openai', apiKey: config.openAiApiKey, model: config.transcribeProvider === 'openai' ? config.transcribeModel : 'gpt-4o-transcribe' },
      { provider: 'openrouter', apiKey: config.openRouterApiKey, model: config.openRouterTranscribeModel ?? 'openai/gpt-4o-transcribe' },
    ];
  }
  const access = transcribeAccess(config);
  return access ? [{ ...access, model: config.transcribeModel }] : [];
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
  if (config.realtimeStt && config.openAiApiKey) return 'realtime';
  if (providerAccess(config)) return 'segments';
  return 'none';
}
