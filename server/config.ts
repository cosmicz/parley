// Server configuration from the environment Vite loads (.env, .env.local and
// the process environment). Keys live here only; nothing in this module is
// imported by the client bundle.

import type { ConfigResponse } from './contract.ts';

export interface ServerConfig extends ConfigResponse {
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
  };
}
