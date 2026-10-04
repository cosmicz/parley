// The Parley dev-server API, mounted as Connect middleware by vite.config.ts.
//
// Every external dependency (fetch, the clock, the event hub) is injected so
// tests drive the real routing over HTTP with fakes. Keys stay in this
// process: responses carry only the public config, a single-use STT key and
// model results.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { providerAccess, publicConfig, transcribeRoutes, type ServerConfig } from './config.ts';
import { suggest } from './coach.ts';
import { isWav, transcribeFirst } from './transcribe.ts';
import { createRealtimeToken, REALTIME_MODEL, REALTIME_RATE } from './realtime.ts';
import { EventHub } from './events.ts';
import type { RealtimeTokenResponse, SttTokenResponse, SuggestRequest, SuggestResponse, TranscribeResponse } from './contract.ts';

export const SONIOX_TEMP_KEY_URL = 'https://api.soniox.com/v1/auth/temporary-api-key';
export const MAX_BODY_BYTES = 64 * 1024;
export const NO_PROVIDER = 'no model provider is configured: set OPENROUTER_API_KEY or OPENAI_API_KEY';
export const MAX_WAV_BYTES = 1024 * 1024;
const WAV_TYPES = new Set(['audio/wav', 'audio/wave', 'audio/x-wav']);

export interface ApiDeps {
  config: ServerConfig;
  hub: EventHub;
  /** Used for Soniox and OpenRouter; tests inject a fake. */
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string) => void;
}

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function createApi(deps: ApiDeps): Middleware {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? ((message) => console.warn(`[parley-api] ${message}`));

  const routes: Record<string, Partial<Record<'GET' | 'POST', Handler>>> = {
    '/api/config': {
      GET: async (_req, res) => sendJson(res, 200, publicConfig(deps.config)),
    },

    '/api/stt-token': {
      GET: async (_req, res) => {
        const key = deps.config.sonioxApiKey;
        if (!key) throw new HttpError(503, 'SONIOX_API_KEY is not configured');
        let upstream: Response;
        try {
          upstream = await fetchImpl(SONIOX_TEMP_KEY_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              usage_type: 'transcribe_websocket',
              expires_in_seconds: 60,
              max_session_duration_seconds: 3600,
              single_use: true,
            }),
          });
        } catch (err) {
          log(`soniox request failed: ${errorMessage(err)}`);
          throw new HttpError(502, 'speech-to-text token request failed');
        }
        if (!upstream.ok) {
          log(`soniox answered ${upstream.status}: ${await upstream.text().catch(() => '')}`);
          throw new HttpError(502, `speech-to-text token request answered ${upstream.status}`);
        }
        const body = (await upstream.json().catch(() => null)) as { api_key?: unknown; expires_at?: unknown } | null;
        if (typeof body?.api_key !== 'string' || typeof body.expires_at !== 'string') {
          throw new HttpError(502, 'speech-to-text token response was malformed');
        }
        sendJson(res, 200, { apiKey: body.api_key, expiresAt: body.expires_at } satisfies SttTokenResponse);
      },
    },

    '/api/realtime-token': {
      GET: async (_req, res) => {
        const apiKey = deps.config.openAiApiKey;
        if (!deps.config.realtimeStt || !apiKey) throw new HttpError(503, 'realtime transcription needs REALTIME_STT=1 and OPENAI_API_KEY');
        let token;
        try {
          token = await createRealtimeToken({ apiKey, fetch: fetchImpl }, deps.config);
        } catch (err) {
          log(`realtime token failed: ${errorMessage(err)}`);
          throw new HttpError(502, `realtime token failed: ${errorMessage(err)}`);
        }
        sendJson(res, 200, {
          apiKey: token.value,
          expiresAt: token.expiresAt,
          model: REALTIME_MODEL,
          sampleRate: REALTIME_RATE,
        } satisfies RealtimeTokenResponse);
      },
    },

    '/api/suggest': {
      POST: async (req, res) => {
        const input = parseSuggestRequest(await readJson(req));
        const access = providerAccess(deps.config);
        if (!access) throw new HttpError(503, NO_PROVIDER);
        let response: SuggestResponse;
        try {
          response = await suggest(
            { ...access, fetch: fetchImpl, now: deps.now },
            { ...input, practiceLanguage: deps.config.practiceLanguage, fallbackLanguage: deps.config.fallbackLanguage, model: deps.config.model },
          );
        } catch (err) {
          log(`model call failed: ${errorMessage(err)}`);
          throw new HttpError(502, `model call failed: ${errorMessage(err)}`);
        }
        sendJson(res, 200, response);
      },
    },

    '/api/transcribe': {
      POST: async (req, res) => {
        const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!WAV_TYPES.has(type)) throw new HttpError(415, 'body must be audio/wav');
        const wav = await readBytes(req, MAX_WAV_BYTES);
        if (!isWav(wav)) throw new HttpError(400, 'body is not a RIFF/WAVE file');
        const routes = transcribeRoutes(deps.config);
        if (routes.length === 0) throw new HttpError(503, NO_PROVIDER);
        let response: TranscribeResponse;
        try {
          response = await transcribeFirst(
            routes.map((route) => ({ ...route, fetch: fetchImpl, now: deps.now })),
            { wav, practiceLanguage: deps.config.practiceLanguage, fallbackLanguage: deps.config.fallbackLanguage },
          );
        } catch (err) {
          log(`transcription failed: ${errorMessage(err)}`);
          throw new HttpError(502, `transcription failed: ${errorMessage(err)}`);
        }
        sendJson(res, 200, response);
      },
    },

    '/api/state': {
      POST: async (req, res) => {
        const state = await readJson(req);
        if (typeof state !== 'object' || state === null || Array.isArray(state)) {
          throw new HttpError(400, 'state must be a JSON object');
        }
        deps.hub.publish('state', state);
        res.writeHead(204).end();
      },
    },

    '/api/reset': {
      POST: async (_req, res) => {
        deps.hub.publish('reset', {});
        res.writeHead(204).end();
      },
    },

    '/api/events': {
      GET: async (_req, res) => {
        deps.hub.subscribe(res);
      },
    },
  };

  return (req, res, next) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/api' && !path.startsWith('/api/')) return next();
    const route = routes[path];
    if (!route) return sendJson(res, 404, { error: `no route ${path}` });
    const handler = route[req.method as 'GET' | 'POST'];
    if (!handler) {
      res.setHeader('Allow', Object.keys(route).join(', '));
      return sendJson(res, 405, { error: `${req.method} not allowed on ${path}` });
    }
    handler(req, res).catch((err: unknown) => {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      log(`unhandled error on ${path}: ${errorMessage(err)}`);
      sendJson(res, 500, { error: 'internal error' });
    });
  };
}

function parseSuggestRequest(body: unknown): SuggestRequest {
  const obj = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof obj.transcript !== 'string') throw new HttpError(400, 'transcript must be a string');
  if (obj.trigger !== 'pause' && obj.trigger !== 'tap') throw new HttpError(400, "trigger must be 'pause' or 'tap'");
  return { transcript: obj.transcript, trigger: obj.trigger };
}

// An oversized body is drained rather than cut off, so the client reads the
// 413 instead of a reset connection.
async function readBytes(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= limit) chunks.push(chunk as Buffer);
  }
  if (size > limit) throw new HttpError(413, `request body larger than ${limit} bytes`);
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const bytes = await readBytes(req, MAX_BODY_BYTES);
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body must be JSON');
  }
}

function sendJson(res: ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
