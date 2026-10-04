import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SonioxStream } from '../src/stt-soniox.ts';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readonly sent: (string | Uint8Array)[] = [];
  readyState = 0;
  private listeners = new Map<string, ((event: { data?: string }) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (event: { data?: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  emit(type: string, data?: string): void {
    if (type === 'open') this.readyState = 1;
    if (type === 'close') this.readyState = 3;
    for (const cb of this.listeners.get(type) ?? []) cb({ data });
  }

  send(data: string | Uint8Array): void { this.sent.push(data); }
  close(): void { this.emit('close'); }
}

function setup(keepaliveMs = 10_000, stopTimeoutMs = 2_000) {
  FakeWebSocket.instances = [];
  const transcripts: string[] = [];
  const errors: { type: string; message: string }[] = [];
  const states: string[] = [];
  const stream = new SonioxStream(
    { getTempKey: async () => 'short-lived', languageHints: ['fr', 'en'], keepaliveMs, stopTimeoutMs },
    { onTranscript: text => transcripts.push(text), onError: err => errors.push(err), onState: state => states.push(state) },
    FakeWebSocket as unknown as typeof WebSocket,
  );
  return { stream, transcripts, errors, states };
}

test('start obtains temporary key and sends Soniox PCM configuration before audio', async () => {
  const { stream, transcripts, states } = setup();
  const started = stream.start();
  await new Promise(resolve => setImmediate(resolve));
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'wss://stt-rt.soniox.com/transcribe-websocket');
  assert.deepEqual(states, ['connecting']);
  socket.emit('open');
  await started;
  assert.deepEqual(JSON.parse(socket.sent[0] as string), {
    api_key: 'short-lived', model: 'stt-rt-v5', audio_format: 'pcm_s16le',
    sample_rate: 16000, num_channels: 1, language_hints: ['fr', 'en'],
    enable_language_identification: true, enable_endpoint_detection: true,
  });
  const pcm = new Uint8Array([1, 2, 3, 4]);
  stream.sendPcm(pcm);
  assert.deepEqual(socket.sent[1], pcm);
  socket.emit('message', JSON.stringify({ tokens: [{ text: 'Je', is_final: true }, { text: ' parle', is_final: false }] }));
  socket.emit('message', JSON.stringify({ tokens: [{ text: ' pense', is_final: false }] }));
  assert.deepEqual(transcripts, ['Je parle', 'Je pense']);
  assert.deepEqual(states, ['connecting', 'open']);
  socket.close();
});

test('idle stream sends keepalive, then stop sends empty binary frame and waits for finish', async () => {
  const { stream, states } = setup(15);
  const started = stream.start();
  await new Promise(resolve => setImmediate(resolve));
  const socket = FakeWebSocket.instances[0];
  socket.emit('open');
  await started;
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(socket.sent.some(item => item === '{"type":"keepalive"}'));
  const stopped = stream.stop();
  assert.deepEqual(socket.sent.at(-1), new Uint8Array());
  socket.emit('message', JSON.stringify({ tokens: [], finished: true }));
  await stopped;
  assert.equal(states.at(-1), 'closed');
});

test('server errors map stable error type and readable message', async () => {
  const { stream, errors } = setup();
  const started = stream.start();
  await new Promise(resolve => setImmediate(resolve));
  const socket = FakeWebSocket.instances[0];
  socket.emit('open');
  await started;
  socket.emit('message', JSON.stringify({ error_type: 'unauthenticated', error_message: 'Expired temporary API key' }));
  assert.deepEqual(errors, [{ type: 'unauthenticated', message: 'Expired temporary API key' }]);
  socket.close();
});

test('early mic frames are ignored; a stopped stream can start again with a fresh socket', async () => {
  const { stream, transcripts, states } = setup();
  stream.sendPcm(new Uint8Array([9, 9]));
  const firstStart = stream.start();
  await new Promise(resolve => setImmediate(resolve));
  stream.sendPcm(new Uint8Array([8, 8]));
  const first = FakeWebSocket.instances[0];
  first.emit('open');
  await firstStart;
  assert.equal(first.sent.length, 1, 'no audio queued before open');
  first.emit('message', JSON.stringify({ tokens: [{ text: 'Ancien', is_final: true }] }));
  const firstStop = stream.stop();
  first.emit('message', JSON.stringify({ finished: true, tokens: [] }));
  await firstStop;

  const secondStart = stream.start();
  await new Promise(resolve => setImmediate(resolve));
  const second = FakeWebSocket.instances[1];
  assert.notEqual(second, first);
  second.emit('open');
  await secondStart;
  first.emit('message', JSON.stringify({ tokens: [{ text: 'Ancien tardif', is_final: true }] }));
  first.emit('error');
  first.emit('close');
  second.emit('message', JSON.stringify({ tokens: [{ text: 'Nouveau', is_final: true }] }));
  assert.deepEqual(transcripts, ['Ancien', 'Nouveau']);
  assert.deepEqual(states, ['connecting', 'open', 'closed', 'connecting', 'open']);
  second.close();
});

test('stop during temporary key fetch prevents a late socket from opening', async () => {
  let releaseKey: (key: string) => void = () => {};
  const states: string[] = [];
  const errors: string[] = [];
  FakeWebSocket.instances = [];
  const stream = new SonioxStream(
    { getTempKey: () => new Promise(resolve => { releaseKey = resolve; }), languageHints: ['fr', 'en'] },
    { onTranscript: () => {}, onError: err => errors.push(err.type), onState: state => states.push(state) },
    FakeWebSocket as unknown as typeof WebSocket,
  );
  const started = stream.start();
  await stream.stop();
  releaseKey('late');
  await assert.rejects(started, /stopped before opening/);
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.deepEqual(states, ['connecting', 'closed']);
  assert.deepEqual(errors, []);
});

test('stop during WebSocket connection rejects start before asynchronous browser close', async () => {
  class AsyncCloseWebSocket extends FakeWebSocket {
    override close(): void { queueMicrotask(() => this.emit('close')); }
  }
  FakeWebSocket.instances = [];
  const states: string[] = [];
  const stream = new SonioxStream(
    { getTempKey: async () => 'short-lived', languageHints: ['fr', 'en'] },
    { onTranscript: () => {}, onError: () => {}, onState: state => states.push(state) },
    AsyncCloseWebSocket as unknown as typeof WebSocket,
  );
  const started = stream.start();
  const rejection = assert.rejects(started, /stopped before opening/);
  await new Promise(resolve => setImmediate(resolve));
  await stream.stop();
  await rejection;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(states, ['connecting', 'closed']);
});

test('stop closes a stalled server after bounded wait and releases caller', async () => {
  const { stream, states, errors } = setup(10_000, 15);
  const started = stream.start();
  await new Promise(resolve => setImmediate(resolve));
  const socket = FakeWebSocket.instances[0];
  socket.emit('open');
  await started;
  await stream.stop(); // Fake server never emits finished or close.
  assert.equal(socket.readyState, 3);
  assert.equal(states.at(-1), 'closed');
  assert.deepEqual(errors, [{ type: 'finish_timeout', message: 'Soniox did not finish within 15 ms' }]);
});
