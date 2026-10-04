// The dev-server API contract, driven over real HTTP on an ephemeral port with
// fakes for fetch and the model client, so no key, network or SDK code is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApi, MAX_WAV_BYTES, NO_PROVIDER, SONIOX_TEMP_KEY_URL, type ApiDeps } from '../server/api.ts';
import { readConfig, type ServerConfig } from '../server/config.ts';
import { EventHub } from '../server/events.ts';

const CONFIG: ServerConfig = {
  practiceLanguage: 'fr',
  fallbackLanguage: 'en',
  model: 'anthropic/claude-haiku-4.5',
  provider: 'openrouter',
  transcribeModel: 'openai/gpt-4o-mini-transcribe',
  realtimeStt: false,
  sonioxApiKey: 'soniox-long-lived',
  openRouterApiKey: 'openrouter-long-lived',
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

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: { model: string; max_tokens: number; messages: { role: string; content: string }[] } & Record<string, unknown>;
}

// A fake OpenRouter: answers every request with `status` and `reply`, or
// rejects like a network failure when given an Error.
function fakeOpenRouter(reply: unknown, status = 200): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

const completion = (content: string | null, finish_reason = 'stop', extra: Record<string, unknown> = {}) => ({
  id: 'gen-1',
  object: 'chat.completion',
  model: 'anthropic/claude-haiku-4.5',
  choices: [{ index: 0, finish_reason, native_finish_reason: 'end_turn', message: { role: 'assistant', content }, ...extra }],
});

async function postSuggest(base: string, body: unknown = { transcript: 'Je voudrais un appointment', trigger: 'pause' }) {
  const res = await fetch(`${base}/api/suggest`, { method: 'POST', body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('config comes from the environment with defaults and never exposes keys', async () => {
  assert.deepEqual(readConfig({ ANTHROPIC_API_KEY: 'retired' }), {
    practiceLanguage: 'fr',
    fallbackLanguage: 'en',
    provider: 'none',
    model: 'anthropic/claude-haiku-4.5',
    transcribeModel: 'openai/gpt-4o-transcribe',
    sonioxApiKey: undefined,
    openRouterApiKey: undefined,
    openAiApiKey: undefined,
    realtimeStt: false,
  });
  const config = readConfig({
    PRACTICE_LANGUAGE: 'es',
    FALLBACK_LANGUAGE: 'ro',
    COACH_MODEL: 'm',
    TRANSCRIBE_MODEL: 't',
    SONIOX_API_KEY: 's',
    OPENROUTER_API_KEY: 'o',
  });
  assert.equal(config.openRouterApiKey, 'o');
  assert.equal(config.transcribeModel, 't');
  const h = await serve({ config });
  try {
    const res = await fetch(`${h.base}/api/config`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { practiceLanguage: 'es', fallbackLanguage: 'ro', model: 'm', provider: 'openrouter', sttMode: 'soniox' });
  } finally {
    await h.close();
  }
});

test('the provider is OpenRouter when its key is set, else OpenAI with OpenAI model ids, else none', () => {
  const both = readConfig({ OPENROUTER_API_KEY: 'o', OPENAI_API_KEY: 'k' });
  assert.equal(both.provider, 'openrouter');
  assert.equal(both.model, 'anthropic/claude-haiku-4.5');

  // The operator's .env at 14:27: an OpenRouter slug left in COACH_MODEL.
  const openAi = readConfig({ OPENAI_API_KEY: 'k', COACH_MODEL: 'anthropic/claude-haiku-4.5', TRANSCRIBE_MODEL: 'openai/gpt-4o-mini-transcribe' });
  assert.equal(openAi.provider, 'openai');
  assert.equal(openAi.model, 'gpt-4.1-mini');
  // The OpenRouter slug is ignored; the OpenAI default applies (gpt-4o-transcribe since 15:00).
  assert.equal(openAi.transcribeModel, 'gpt-4o-transcribe');
  assert.equal(readConfig({ OPENAI_API_KEY: 'k', COACH_MODEL: 'gpt-4.1' }).model, 'gpt-4.1');
  assert.equal(readConfig({ OPENAI_API_KEY: 'k', COACH_MODEL: 'gpt-4.1', OPENAI_COACH_MODEL: 'gpt-4o' }).model, 'gpt-4o');
  assert.equal(readConfig({ OPENAI_API_KEY: 'k', TRANSCRIBE_MODEL: 'gpt-4o-transcribe' }).transcribeModel, 'gpt-4o-transcribe');
  assert.equal(readConfig({}).provider, 'none');
});

test('sttMode prefers Soniox streaming, falls back to OpenRouter clips, else none', async () => {
  const cases: [Partial<ServerConfig>, string][] = [
    [{}, 'soniox'],
    [{ openRouterApiKey: undefined }, 'soniox'],
    [{ sonioxApiKey: undefined }, 'segments'],
    [{ sonioxApiKey: undefined, openRouterApiKey: undefined }, 'none'],
    [{ sonioxApiKey: undefined, openRouterApiKey: undefined, provider: 'openai', openAiApiKey: 'k' }, 'segments'],
    [{ sonioxApiKey: undefined, realtimeStt: true, openAiApiKey: 'k' }, 'realtime'],
    [{ sonioxApiKey: undefined, realtimeStt: true }, 'segments'],
  ];
  for (const [override, expected] of cases) {
    const h = await serve({ config: { ...CONFIG, ...override } });
    try {
      const body = await (await fetch(`${h.base}/api/config`)).json();
      assert.equal(body.sttMode, expected, JSON.stringify(override));
    } finally {
      await h.close();
    }
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

test('suggest sends the configured prompt to OpenRouter and returns the parsed suggestion with model time', async () => {
  const router = fakeOpenRouter(completion('{"suggestion": "un rendez-vous"}'));
  let clock = 1000;
  const h = await serve({ fetch: router.fetch, now: () => (clock += 420) });
  try {
    const { status, body } = await postSuggest(h.base);
    assert.equal(status, 200);
    assert.deepEqual(body, { result: { kind: 'suggestion', text: 'un rendez-vous' }, modelMs: 420 });
    assert.equal(router.calls.length, 1);
    const call = router.calls[0];
    assert.equal(call.url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(call.headers.Authorization, 'Bearer openrouter-long-lived');
    assert.equal(call.headers['X-OpenRouter-Title'], 'Parley');
    assert.equal(call.body.model, 'anthropic/claude-haiku-4.5');
    assert.equal(call.body.max_tokens, 256);
    assert.deepEqual(call.body.messages.map((m) => m.role), ['system', 'user']);
    assert.match(call.body.messages[0].content, /practising French and is stronger in English/);
    assert.match(call.body.messages[1].content, /Trigger: pause/);
    assert.match(call.body.messages[1].content, /Je voudrais un appointment/);
  } finally {
    await h.close();
  }
});

test('suggest maps abstain, invalid output, empty content, a content filter and a refusal', async () => {
  const cases: [unknown, unknown][] = [
    [completion('{"abstain": true}'), { kind: 'abstain' }],
    [completion('Sure! Try saying "un rendez-vous".'), { kind: 'invalid', reason: 'not JSON' }],
    [completion(null), { kind: 'invalid', reason: 'not JSON' }],
    [completion('{"suggestion": "x"}', 'content_filter'), { kind: 'abstain' }],
    [completion('', 'stop', { native_finish_reason: 'refusal' }), { kind: 'abstain' }],
  ];
  for (const [reply, expected] of cases) {
    const h = await serve({ fetch: fakeOpenRouter(reply).fetch });
    try {
      const { status, body } = await postSuggest(h.base, { transcript: 'euh', trigger: 'tap' });
      assert.equal(status, 200);
      assert.deepEqual(body.result, expected, `reply ${JSON.stringify(reply)}`);
    } finally {
      await h.close();
    }
  }
});

test('suggest rejects a bad body and reports a missing key without calling OpenRouter', async () => {
  const router = fakeOpenRouter(completion('{"abstain": true}'));
  const ok = await serve({ fetch: router.fetch });
  try {
    assert.equal((await postSuggest(ok.base, { transcript: 'x', trigger: 'shout' })).status, 400);
    assert.equal((await postSuggest(ok.base, { trigger: 'tap' })).status, 400);
    const res = await fetch(`${ok.base}/api/suggest`, { method: 'POST', body: 'not json' });
    assert.equal(res.status, 400);
  } finally {
    await ok.close();
  }

  const noKey = await serve({ config: { ...CONFIG, openRouterApiKey: undefined }, fetch: router.fetch });
  try {
    const { status, body } = await postSuggest(noKey.base);
    assert.equal(status, 503);
    assert.equal(body.error, NO_PROVIDER);
  } finally {
    await noKey.close();
  }
  assert.equal(router.calls.length, 0);
});

test('suggest maps HTTP errors, in-band errors, malformed replies and network failures to 502 without the key', async () => {
  const cases: [unknown, number, RegExp][] = [
    [{ error: { code: 402, message: 'Insufficient credits' } }, 402, /402: Insufficient credits/],
    [{ error: { code: 429, message: 'Rate limited' } }, 429, /429: Rate limited/],
    [completion(null, 'error', { error: { code: 502, message: 'Provider overloaded' } }), 200, /Provider overloaded/],
    [{ object: 'chat.completion', choices: [] }, 200, /no choices/],
    [new TypeError('fetch failed'), 0, /request failed: fetch failed/],
  ];
  for (const [reply, status, pattern] of cases) {
    const h = await serve({ fetch: fakeOpenRouter(reply, status).fetch });
    try {
      const res = await fetch(`${h.base}/api/suggest`, { method: 'POST', body: JSON.stringify({ transcript: 'x', trigger: 'tap' }) });
      const text = await res.text();
      assert.equal(res.status, 502, `reply ${JSON.stringify(reply)}`);
      assert.match(JSON.parse(text).error, pattern);
      assert.ok(!text.includes('openrouter-long-lived'), 'long-lived key leaked to the client');
    } finally {
      await h.close();
    }
  }
});

// A minimal 16 kHz mono 16-bit WAV with `samples` samples of a ramp.
function wav(samples: number): Uint8Array {
  const out = Buffer.alloc(44 + samples * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + samples * 2, 4);
  out.write('WAVEfmt ', 8, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24);
  out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) out.writeInt16LE((i * 37) % 30000, 44 + i * 2);
  return out;
}

function fakeTranscriber(reply: unknown, status = 200): { fetch: typeof fetch; calls: { url: string; headers: Record<string, string>; body: any }[] } {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

const HINT = 'Mostly French with occasional English words; write each word in the language spoken; keep fillers like euh and um.';

const postWav = (base: string, body: Uint8Array, type = 'audio/wav') =>
  fetch(`${base}/api/transcribe`, { method: 'POST', headers: { 'Content-Type': type }, body: new Blob([body as Uint8Array<ArrayBuffer>]) });

test('transcribe sends the clip to OpenRouter as base64 JSON with a mixed-language hint and no forced language', async () => {
  const stt = fakeTranscriber({ text: ' Je voudrais um un rendez-vous ', usage: { seconds: 1.2 } });
  let clock = 0;
  const h = await serve({ fetch: stt.fetch, now: () => (clock += 640) });
  try {
    const clip = wav(16000);
    const res = await postWav(h.base, clip);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: 'Je voudrais um un rendez-vous', sttMs: 640 });
    assert.equal(stt.calls.length, 1);
    const call = stt.calls[0];
    assert.equal(call.url, 'https://openrouter.ai/api/v1/audio/transcriptions');
    assert.equal(call.headers.Authorization, 'Bearer openrouter-long-lived');
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal(call.body.model, 'openai/gpt-4o-mini-transcribe');
    assert.equal(call.body.input_audio.format, 'wav');
    assert.ok(Buffer.from(call.body.input_audio.data, 'base64').equals(clip), 'clip bytes survive the base64 round trip');
    assert.ok(!('language' in call.body), 'language must be auto-detected so slips survive');
    const hint = HINT;
    assert.deepEqual(call.body.provider, { options: { openai: { prompt: hint }, groq: { prompt: hint } } });
  } finally {
    await h.close();
  }
});

test('transcribe rejects a wrong type, a non-WAV body and a clip over 1 MB before calling OpenRouter', async () => {
  const stt = fakeTranscriber({ text: 'x' });
  const h = await serve({ fetch: stt.fetch });
  try {
    assert.equal((await postWav(h.base, wav(100), 'application/json')).status, 415);
    assert.equal((await postWav(h.base, Buffer.from('not a wav file at all'))).status, 400);
    const big = await postWav(h.base, wav(MAX_WAV_BYTES / 2));
    assert.equal(big.status, 413);
    assert.match((await big.json()).error, /larger than 1048576 bytes/);
    assert.equal((await postWav(h.base, wav(MAX_WAV_BYTES / 2 - 22))).status, 200, 'exactly 1 MB is accepted');
    assert.equal(stt.calls.length, 1);
  } finally {
    await h.close();
  }
});

test('transcribe without an OpenRouter key answers 503 and never calls upstream', async () => {
  const stt = fakeTranscriber({ text: 'x' });
  const h = await serve({ config: { ...CONFIG, openRouterApiKey: undefined }, fetch: stt.fetch });
  try {
    const res = await postWav(h.base, wav(100));
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, NO_PROVIDER);
    assert.equal(stt.calls.length, 0);
  } finally {
    await h.close();
  }
});

test('transcribe maps HTTP errors, a missing text field and network failures to 502 without the key', async () => {
  const cases: [unknown, number, RegExp][] = [
    [{ error: { code: 400, message: 'Unsupported audio format' } }, 400, /400: Unsupported audio format/],
    [{ error: { code: 402, message: 'Insufficient credits' } }, 402, /402: Insufficient credits/],
    [{ usage: { seconds: 1 } }, 200, /no text in response/],
    [new TypeError('fetch failed'), 0, /request failed: fetch failed/],
  ];
  for (const [reply, status, pattern] of cases) {
    const h = await serve({ fetch: fakeTranscriber(reply, status).fetch });
    try {
      const res = await postWav(h.base, wav(100));
      const text = await res.text();
      assert.equal(res.status, 502, `reply ${JSON.stringify(reply)}`);
      assert.match(JSON.parse(text).error, pattern);
      assert.ok(!text.includes('openrouter-long-lived'), 'long-lived key leaked to the client');
    } finally {
      await h.close();
    }
  }
});

const OPENAI_CONFIG: ServerConfig = {
  ...CONFIG,
  provider: 'openai',
  model: 'gpt-4.1-mini',
  transcribeModel: 'gpt-4o-mini-transcribe',
  sonioxApiKey: undefined,
  openRouterApiKey: undefined,
  openAiApiKey: 'openai-long-lived',
};

test('with only an OpenAI key, suggest calls OpenAI chat completions with max_completion_tokens', async () => {
  const router = fakeOpenRouter(completion('{"suggestion": "un rendez-vous"}'));
  const h = await serve({ config: OPENAI_CONFIG, fetch: router.fetch });
  try {
    const { status, body } = await postSuggest(h.base);
    assert.equal(status, 200);
    assert.deepEqual(body.result, { kind: 'suggestion', text: 'un rendez-vous' });
    const call = router.calls[0];
    assert.equal(call.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(call.headers.Authorization, 'Bearer openai-long-lived');
    assert.equal(call.body.model, 'gpt-4.1-mini');
    assert.equal(call.body.max_completion_tokens, 256);
    assert.ok(!Object.hasOwn(call.body, 'max_tokens'), 'OpenAI takes max_completion_tokens');
    assert.deepEqual(call.body.messages.map((m) => m.role), ['system', 'user']);
  } finally {
    await h.close();
  }
});

test('an OpenAI refusal maps to abstain and an OpenAI error to 502 without the key', async () => {
  const refusal = await serve({ config: OPENAI_CONFIG, fetch: fakeOpenRouter(completion(null, 'stop', { message: { role: 'assistant', content: null, refusal: 'I cannot help.' } })).fetch });
  try {
    const { status, body } = await postSuggest(refusal.base);
    assert.equal(status, 200);
    assert.deepEqual(body.result, { kind: 'abstain' });
  } finally {
    await refusal.close();
  }
  const failing = await serve({ config: OPENAI_CONFIG, fetch: fakeOpenRouter({ error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } }, 401).fetch });
  try {
    const res = await fetch(`${failing.base}/api/suggest`, { method: 'POST', body: JSON.stringify({ transcript: 'x', trigger: 'tap' }) });
    const text = await res.text();
    assert.equal(res.status, 502);
    assert.match(JSON.parse(text).error, /OpenAI answered 401: Incorrect API key provided/);
    assert.ok(!text.includes('openai-long-lived'));
  } finally {
    await failing.close();
  }
});

test('with only an OpenAI key, transcribe posts multipart form data with the prompt and no language', async () => {
  const calls: { url: string; headers: Record<string, string>; form: FormData }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, form: init.body as FormData });
    return new Response(JSON.stringify({ text: 'Je voudrais um appointment' }), { status: 200 });
  }) as typeof fetch;
  const h = await serve({ config: OPENAI_CONFIG, fetch: fakeFetch });
  try {
    const clip = wav(800);
    const res = await postWav(h.base, clip);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).text, 'Je voudrais um appointment');
    const call = calls[0];
    assert.equal(call.url, 'https://api.openai.com/v1/audio/transcriptions');
    assert.deepEqual(call.headers, { Authorization: 'Bearer openai-long-lived' }, 'fetch must set the multipart boundary');
    assert.ok(call.form instanceof FormData);
    const file = call.form.get('file') as File;
    assert.equal(file.name, 'clip.wav');
    assert.equal(file.type, 'audio/wav');
    assert.ok(Buffer.from(await file.arrayBuffer()).equals(clip), 'clip bytes are uploaded unchanged');
    assert.equal(call.form.get('model'), 'gpt-4o-mini-transcribe');
    assert.equal(call.form.get('response_format'), 'json');
    assert.equal(call.form.get('prompt'), HINT);
    assert.equal(call.form.get('language'), null, 'language must be auto-detected so slips survive');
  } finally {
    await h.close();
  }
});

test('realtime-token mints an ephemeral transcription secret from OpenAI', async () => {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    return new Response(JSON.stringify({ value: 'ek_abc', expires_at: 1791150000, session: {} }), { status: 200 });
  }) as typeof fetch;
  const h = await serve({ config: { ...OPENAI_CONFIG, realtimeStt: true }, fetch: fakeFetch });
  try {
    const res = await fetch(`${h.base}/api/realtime-token`);
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(text), { apiKey: 'ek_abc', expiresAt: 1791150000, model: 'gpt-live-transcribe', sampleRate: 24000 });
    assert.ok(!text.includes('openai-long-lived'));
    const call = calls[0];
    assert.equal(call.url, 'https://api.openai.com/v1/realtime/client_secrets');
    assert.equal(call.headers.Authorization, 'Bearer openai-long-lived');
    assert.deepEqual(call.body.expires_after, { anchor: 'created_at', seconds: 600 });
    assert.deepEqual(call.body.session, {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: 'gpt-live-transcribe', prompt: HINT, languages: ['fr', 'en'] },
          turn_detection: null,
        },
      },
    });
  } finally {
    await h.close();
  }
});

test('realtime-token needs the flag and an OpenAI key, and maps upstream failure to 502', async () => {
  let called = 0;
  const ok = (async () => {
    called++;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  for (const config of [OPENAI_CONFIG, { ...OPENAI_CONFIG, realtimeStt: true, openAiApiKey: undefined }]) {
    const h = await serve({ config, fetch: ok });
    try {
      assert.equal((await fetch(`${h.base}/api/realtime-token`)).status, 503);
    } finally {
      await h.close();
    }
  }
  assert.equal(called, 0);
  const cases: [Response, RegExp][] = [
    [new Response(JSON.stringify({ error: { message: 'model not found' } }), { status: 404 }), /OpenAI answered 404: model not found/],
    [new Response(JSON.stringify({ value: 'ek_x' }), { status: 200 }), /malformed/],
  ];
  for (const [reply, pattern] of cases) {
    const h = await serve({ config: { ...OPENAI_CONFIG, realtimeStt: true }, fetch: (async () => reply) as typeof fetch });
    try {
      const res = await fetch(`${h.base}/api/realtime-token`);
      const text = await res.text();
      assert.equal(res.status, 502);
      assert.match(JSON.parse(text).error, pattern);
      assert.ok(!text.includes('openai-long-lived'));
    } finally {
      await h.close();
    }
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
