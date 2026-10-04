// Server configuration from the environment Vite loads (.env, .env.local and
// the process environment). Keys live here only; nothing in this module is
// imported by the client bundle.

import type { ConfigResponse, SttMode } from './contract.ts';

export interface ServerConfig extends Omit<ConfigResponse, 'sttMode'> {
  /** OpenRouter model id for POST /api/transcribe. */
  transcribeModel: string;
  sonioxApiKey?: string;
  openRouterApiKey?: string;
}

const nonEmpty = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export function readConfig(env: Record<string, string | undefined>): ServerConfig {
  return {
    practiceLanguage: nonEmpty(env.PRACTICE_LANGUAGE) ?? 'fr',
    fallbackLanguage: nonEmpty(env.FALLBACK_LANGUAGE) ?? 'en',
    // OpenRouter model id, listed in OpenRouter's public model list 2026-10-04 (pahax-6ws).
    model: nonEmpty(env.COACH_MODEL) ?? 'anthropic/claude-haiku-4.5',
    // Listed with output_modalities=transcription on 2026-10-04 (pahax-t37);
    // gpt-4o-transcribe class, the cheapest of the OpenAI transcribers.
    transcribeModel: nonEmpty(env.TRANSCRIBE_MODEL) ?? 'openai/gpt-4o-mini-transcribe',
    sonioxApiKey: nonEmpty(env.SONIOX_API_KEY),
    openRouterApiKey: nonEmpty(env.OPENROUTER_API_KEY),
  };
}

/** The public view of the config; never includes keys. */
export function publicConfig(config: ServerConfig): ConfigResponse {
  return {
    practiceLanguage: config.practiceLanguage,
    fallbackLanguage: config.fallbackLanguage,
    model: config.model,
    sttMode: sttMode(config),
  };
}

/** Soniox streaming wins when both keys are present. */
export function sttMode(config: ServerConfig): SttMode {
  if (config.sonioxApiKey) return 'soniox';
  if (config.openRouterApiKey) return 'segments';
  return 'none';
}
