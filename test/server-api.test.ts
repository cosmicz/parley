// The dev-server API contract, driven over real HTTP on an ephemeral port with
// fakes for fetch and the model client, so no key, network or SDK code is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApi, SONIOX_TEMP_KEY_URL, type ApiDeps } from '../server/api.ts';
import type { MessagesClient, ModelReply } from '../server/coach.ts';
import { readConfig, type ServerConfig } from '../server/config.ts';
import { EventHub } from '../server/events.ts';

const CONFIG: ServerConfig = {
  practiceLanguage: 'fr',
  fallbackLanguage: 'en',
  model: 'claude-haiku-4-5',
  sonioxApiKey: 'soniox-long-lived',
  anthropicApiKey: 'anthropic-long-lived',
};

interface Harness {
  base: string;
  hub: EventHub;
  close: () => Promise<void>;
}

async function serve(overrides: Partial<ApiDeps> = {}): Promise<Harness> {
  const hub = overrides.hub ?? new EventHub();
  const api = createApi({ config: CONFIG, hub, log: () => {}, ...overrides });
  const server: Server = createServer((req, res) => api(req, res, () => res.writeHead(418).end('next')));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    hub,
    close: async () => {
      hub.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function fakeModel(reply: ModelReply | Error): { client: () => Promise<MessagesClient>; calls: unknown[] } {
  const calls: unknown[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (params) => {
        calls.push(params);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
  return { client: async () => client, calls };
}

const textReply = (text: string): ModelReply => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });

async function postSuggest(base: string, body: unknown = { transcript: 'Je voudrais un appointment', trigger: 'pause' }) {
  const res = await fetch(`${base}/api/suggest`, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('config comes from the environment with defaults and never exposes keys', async () => {
  assert.deepEqual(
    { ...readConfig({}), sonioxApiKey: undefined, anthropicApiKey: undefined },
    { practiceLanguage: 'fr', fallbackLanguage: 'en', model: 'claude-haiku-4-5', sonioxApiKey: undefined, anthropicApiKey: undefined },
  );
  const config = readConfig({ PRACTICE_LANGUAGE: 'es', FALLBACK_LANGUAGE: 'ro', COACH_MODEL: 'm', SONIOX_API_KEY: 's', ANTHROPIC_API_KEY: 'a' });
  const h = await serve({ config });
  try {
    const res = await fetch(`${h.base}/api/config`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { practiceLanguage: 'es', fallbackLanguage: 'ro', model: 'm' });
  } finally {
    await h.close();
  }
});

test('stt-token exchanges the long-lived key for a single-use temporary key', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ api_key: 'temp:abc', expires_at: '2026-10-04T13:31:00Z' }), { status: 201 });
  }) as typeof fetch;
  const h = await serve({ fetch: fakeFetch });
  try {
    const res = await fetch(`${h.base}/api/stt-token`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(text), { apiKey: 'temp:abc', expiresAt: '2026-10-04T13:31:00Z' });
    assert.ok(!text.includes('soniox-long-lived'), 'long-lived key leaked to the client');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, SONIOX_TEMP_KEY_URL);
    assert.equal(requests[0].init.method, 'POST');
    assert.equal((requests[0].init.headers as Record<string, string>).Authorization, 'Bearer soniox-long-lived');
    assert.deepEqual(JSON.parse(requests[0].init.body as string), {
      usage_type: 'transcribe_websocket',
      expires_in_seconds: 60,
      max_session_duration_seconds: 3600,
      single_use: true,
    });
  } finally {
    await h.close();
  }
});

test('stt-token without a key answers 503 and never calls Soniox', async () => {
  let called = false;
  const fakeFetch = (async () => {
    called = true;
    return new Response('{}', { status: 201 });
  }) as typeof fetch;
  const h = await serve({ config: { ...CONFIG, sonioxApiKey: undefined }, fetch: fakeFetch });
  try {
    const res = await fetch(`${h.base}/api/stt-token`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /SONIOX_API_KEY/);
    assert.equal(called, false);
  } finally {
    await h.close();
  }
});

test('stt-token maps an upstream failure to 502', async () => {
  const fakeFetch = (async () => new Response('{"error":"unauthorized"}', { status: 401 })) as typeof fetch;
  const h = await serve({ fetch: fakeFetch });
  try {
    const res = await fetch(`${h.base}/api/stt-token`);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /401/);
  } finally {
    await h.close();
  }
});

test('suggest sends the configured prompt and returns the parsed suggestion with model time', async () => {
  const model = fakeModel(textReply('{"suggestion": "un rendez-vous"}'));
  let clock = 1000;
  const h = await serve({ coachClient: model.client, now: () => (clock += 420) });
  try {
    const { status, body } = await postSuggest(h.base);
    assert.equal(status, 200);
    assert.deepEqual(body, { result: { kind: 'suggestion', text: 'un rendez-vous' }, modelMs: 420 });
    const params = model.calls[0] as { model: string; max_tokens: number; system: string; messages: { role: string; content: string }[] };
    assert.equal(params.model, 'claude-haiku-4-5');
    assert.equal(params.max_tokens, 256);
    assert.match(params.system, /practising French and is stronger in English/);
    assert.equal(params.messages.length, 1);
    assert.equal(params.messages[0].role, 'user');
    assert.match(params.messages[0].content, /Trigger: pause/);
    assert.match(params.messages[0].content, /Je voudrais un appointment/);
    assert.ok(!('thinking' in params), 'no thinking parameter');
  } finally {
    await h.close();
  }
});

test('suggest maps abstain, invalid output and a refusal', async () => {
  const cases: [ModelReply, unknown][] = [
    [textReply('{"abstain": true}'), { kind: 'abstain' }],
    [textReply('Sure! Try saying "un rendez-vous".'), { kind: 'invalid', reason: 'not JSON' }],
    [{ content: [{ type: 'text', text: '{"suggestion": "x"}' }], stop_reason: 'refusal' }, { kind: 'abstain' }],
    [{ content: [], stop_reason: 'refusal' }, { kind: 'abstain' }],
  ];
  for (const [reply, expected] of cases) {
    const h = await serve({ coachClient: fakeModel(reply).client });
    try {
      const { status, body } = await postSuggest(h.base, { transcript: 'euh', trigger: 'tap' });
      assert.equal(status, 200);
      assert.deepEqual(body.result, expected, `reply ${JSON.stringify(reply)}`);
    } finally {
      await h.close();
    }
  }
});

test('suggest rejects a bad body, reports a missing key and maps model errors to 502', async () => {
  const ok = await serve({ coachClient: fakeModel(textReply('{"abstain": true}')).client });
  try {
    assert.equal((await postSuggest(ok.base, { transcript: 'x', trigger: 'shout' })).status, 400);
    assert.equal((await postSuggest(ok.base, { trigger: 'tap' })).status, 400);
    const res = await fetch(`${ok.base}/api/suggest`, { method: 'POST', body: 'not json' });
    assert.equal(res.status, 400);
  } finally {
    await ok.close();
  }

  const noKey = await serve({ coachClient: undefined });
  try {
    const { status, body } = await postSuggest(noKey.base);
    assert.equal(status, 503);
    assert.match(body.error, /ANTHROPIC_API_KEY/);
  } finally {
    await noKey.close();
  }

  const failing = await serve({ coachClient: fakeModel(Object.assign(new Error('overloaded'), { status: 529 })).client });
  try {
    const { status, body } = await postSuggest(failing.base);
    assert.equal(status, 502);
    assert.match(body.error, /overloaded/);
  } finally {
    await failing.close();
  }
});

// Reads SSE frames from a fetch body until `count` events have arrived, failing
// after a deadline so a missing event is a failure rather than a hang.
async function readEvents(res: Response, count: number, deadlineMs = 1000): Promise<{ event: string; data: unknown }[]> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: { event: string; data: unknown }[] = [];
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`got ${events.length} of ${count} events before the deadline`)), deadlineMs);
  });
  try {
    while (events.length < count) {
      const { value, done } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data !== undefined) events.push({ event, data: JSON.parse(data) });
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel();
  }
  return events;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(condition(), 'condition not reached');
}

test('events stream relays posted state unchanged and reset to every subscriber', async () => {
  const h = await serve();
  try {
    const first = await fetch(`${h.base}/api/events`);
    const second = await fetch(`${h.base}/api/events`);
    assert.equal(first.status, 200);
    assert.match(first.headers.get('content-type') ?? '', /^text\/event-stream/);
    await waitFor(() => h.hub.size === 2);

    const state = { transcript: 'Je voudrais', suggestion: 'un rendez-vous', phase: 'suggesting', pauseToHudDispatchMs: 812, extra: { kept: true } };
    const posted = await fetch(`${h.base}/api/state`, { method: 'POST', body: JSON.stringify(state) });
    assert.equal(posted.status, 204);
    const reset = await fetch(`${h.base}/api/reset`, { method: 'POST' });
    assert.equal(reset.status, 204);

    const expected = [
      { event: 'state', data: state },
      { event: 'reset', data: {} },
    ];
    assert.deepEqual(await readEvents(first, 2), expected);
    assert.deepEqual(await readEvents(second, 2), expected);
  } finally {
    await h.close();
  }
});

test('a new subscriber receives the last state, and nothing after a reset', async () => {
  const h = await serve();
  try {
    const state = { transcript: 'Bonjour', suggestion: null, phase: 'listening', pauseToHudDispatchMs: null };
    await fetch(`${h.base}/api/state`, { method: 'POST', body: JSON.stringify(state) });
    const late = await fetch(`${h.base}/api/events`);
    assert.deepEqual(await readEvents(late, 1), [{ event: 'state', data: state }]);

    await fetch(`${h.base}/api/reset`, { method: 'POST' });
    const afterReset = await fetch(`${h.base}/api/events`);
    await waitFor(() => h.hub.size >= 1);
    await fetch(`${h.base}/api/reset`, { method: 'POST' });
    assert.deepEqual(await readEvents(afterReset, 1), [{ event: 'reset', data: {} }]);
  } finally {
    await h.close();
  }
});

test('state must be a JSON object; unknown routes, wrong methods and non-API paths are distinguished', async () => {
  const h = await serve();
  try {
    assert.equal((await fetch(`${h.base}/api/state`, { method: 'POST', body: '[1]' })).status, 400);
    assert.equal((await fetch(`${h.base}/api/nope`)).status, 404);
    const wrong = await fetch(`${h.base}/api/suggest`);
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'POST');
    const passthrough = await fetch(`${h.base}/companion.html`);
    assert.equal(passthrough.status, 418, 'non-API requests fall through to Vite');
  } finally {
    await h.close();
  }
});
