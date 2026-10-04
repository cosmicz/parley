// Ephemeral client secrets for OpenAI realtime transcription (pahax-g2x
// spike), so the browser streams audio to OpenAI without the long-lived key.
//
// Per developers.openai.com (read 2026-10-04): POST /v1/realtime/client_secrets
// with { expires_after, session } returns { value: 'ek_...', expires_at,
// session }. A transcription session is type 'transcription' with 24 kHz PCM
// input; gpt-live-transcribe takes no turn detection (the client commits each
// turn) and uses `languages` rather than `language`.

import { providerLabel } from './coach.ts';
import { OPENAI_API, openAiHeaders } from './openai.ts';
import { upstreamErrorText } from './openrouter.ts';
import { transcriptionHint } from './transcribe.ts';

export const OPENAI_CLIENT_SECRETS_URL = `${OPENAI_API}/realtime/client_secrets`;
export const REALTIME_MODEL = 'gpt-live-transcribe';
export const REALTIME_RATE = 24_000;
const SECRET_TTL_SECONDS = 600;
const TIMEOUT_MS = 10_000;

export class RealtimeTokenError extends Error {}

export interface RealtimeToken {
  value: string;
  expiresAt: number;
}

export async function createRealtimeToken(
  access: { apiKey: string; fetch: typeof fetch },
  languages: { practiceLanguage: string; fallbackLanguage: string },
): Promise<RealtimeToken> {
  let response: Response;
  try {
    response = await access.fetch(OPENAI_CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: openAiHeaders(access.apiKey),
      body: JSON.stringify({
        expires_after: { anchor: 'created_at', seconds: SECRET_TTL_SECONDS },
        session: {
          type: 'transcription',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: REALTIME_RATE },
              transcription: {
                model: REALTIME_MODEL,
                prompt: transcriptionHint(languages.practiceLanguage, languages.fallbackLanguage),
                languages: [languages.practiceLanguage, languages.fallbackLanguage],
              },
              turn_detection: null,
            },
          },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new RealtimeTokenError(`request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = (await response.json().catch(() => null)) as { value?: unknown; expires_at?: unknown } | null;
  if (!response.ok) throw new RealtimeTokenError(`${providerLabel('openai')} answered ${response.status}: ${upstreamErrorText(body)}`);
  if (typeof body?.value !== 'string' || typeof body.expires_at !== 'number') {
    throw new RealtimeTokenError('client secret response was malformed');
  }
  return { value: body.value, expiresAt: body.expires_at };
}
