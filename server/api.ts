// The Parley dev-server API, mounted as Connect middleware by vite.config.ts.
//
// Every external dependency (fetch, the clock, the event hub) is injected so
// tests drive the real routing over HTTP with fakes. Keys stay in this
// process: responses carry only the public config, a single-use STT key and
// model results.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { publicConfig, type ServerConfig } from './config.ts';
import { suggest } from './coach.ts';
import { EventHub } from './events.ts';
import type { SttTokenResponse, SuggestRequest, SuggestResponse } from './contract.ts';

export const SONIOX_TEMP_KEY_URL = 'https://api.soniox.com/v1/auth/temporary-api-key';
export const MAX_BODY_BYTES = 64 * 1024;

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

    '/api/suggest': {
      POST: async (req, res) => {
        const input = parseSuggestRequest(await readJson(req));
        const apiKey = deps.config.openRouterApiKey;
        if (!apiKey) throw new HttpError(503, 'OPENROUTER_API_KEY is not configured');
        let response: SuggestResponse;
        try {
          response = await suggest(
            { apiKey, fetch: fetchImpl, now: deps.now },
            { ...input, practiceLanguage: deps.config.practiceLanguage, fallbackLanguage: deps.config.fallbackLanguage, model: deps.config.model },
          );
        } catch (err) {
          log(`model call failed: ${errorMessage(err)}`);
          throw new HttpError(502, `model call failed: ${errorMessage(err)}`);
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

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
