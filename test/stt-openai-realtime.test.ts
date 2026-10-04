// The realtime transcription client against a fake WebSocket: auth by
// subprotocol, 24 kHz PCM16 appends, partials for display, one final
// transcript per committed turn, and stale events ignored after stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_URL, LinearPcm16Resampler, RealtimeStt } from '../src/stt-openai-realtime.ts';

class FakeSocket {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readonly url: string;
  readonly protocols: string[];
  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
    });
  }
  send(data: string) {
    const msg = JSON.parse(data);
    this.sent.push(msg);
  }
  close() {
    this.readyState = 3;
  }
  emit(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

function harness(flushTimeoutMs = 200) {
  const log = { transcripts: [] as string[], partials: [] as string[], errors: [] as string[], states: [] as string[] };
  const stt = new RealtimeStt(
    { getToken: async () => ({ apiKey: 'ek_test', sampleRate: 24000 }), flushTimeoutMs },
    {
      onTranscript: (t) => log.transcripts.push(t),
      onPartial: (t) => log.partials.push(t),
      onError: (e) => log.errors.push(e.type),
      onState: (s) => log.states.push(s),
    },
    FakeSocket as unknown as typeof WebSocket,
  );
  return { stt, log };
}

const pcm16 = (samples: number[]): Uint8Array => {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return out;
};
const int16s = (bytes: Uint8Array): number[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true));
};

test('connects with the ephemeral key as a subprotocol and appends 24 kHz base64 PCM', async () => {
  const { stt, log } = harness();
  await stt.start();
  const socket = FakeSocket.last!;
  assert.equal(socket.url, DEFAULT_URL);
  assert.deepEqual(socket.protocols, ['realtime', 'openai-insecure-api-key.ek_test']);
  assert.deepEqual(log.states, ['connecting', 'open']);
  stt.sendPcm(pcm16(new Array(1600).fill(1000)));
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].type, 'input_audio_buffer.append');
  const sent = int16s(new Uint8Array(Buffer.from(socket.sent[0].audio, 'base64')));
  assert.ok(Math.abs(sent.length - 2400) <= 1, `100 ms at 24 kHz, got ${sent.length} samples`);
  assert.ok(sent.every((s) => s === 1000));
});

test('the resampler is continuous across chunks, including odd byte splits', () => {
  const input = pcm16(Array.from({ length: 999 }, (_, i) => Math.round(8000 * Math.sin(i / 7))));
  const whole = new LinearPcm16Resampler(16000, 24000).push(input);
  const r = new LinearPcm16Resampler(16000, 24000);
  const parts = [input.subarray(0, 301), input.subarray(301, 302), input.subarray(302, 1001), input.subarray(1001)].map((p) => r.push(p));
  assert.deepEqual(int16s(new Uint8Array(Buffer.concat(parts))), int16s(whole));
});

test('deltas show as partials; flush commits and resolves with the final transcript', async () => {
  const { stt, log } = harness();
  await stt.start();
  const socket = FakeSocket.last!;
  stt.sendPcm(pcm16([1, 2, 3, 4]));
  socket.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'Je vou' });
  socket.emit({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'i1', delta: 'drais' });
  assert.deepEqual(log.partials, ['Je vou', 'Je voudrais']);
  assert.deepEqual(log.transcripts, [], 'partials never reach onTranscript');

  const flushed = stt.flush();
  assert.equal(socket.sent.at(-1).type, 'input_audio_buffer.commit');
  socket.emit({ type: 'input_audio_buffer.committed', item_id: 'i1' });
  socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript: ' Je voudrais um appointment ' });
  await flushed;
  assert.deepEqual(log.transcripts, ['Je voudrais um appointment']);

  stt.sendPcm(pcm16([5, 6]));
  const second = stt.flush();
  socket.emit({ type: 'input_audio_buffer.committed', item_id: 'i2' });
  socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i2', transcript: 'pour demain' });
  await second;
  assert.equal(log.transcripts.at(-1), 'Je voudrais um appointment pour demain');
  assert.deepEqual(log.errors, []);
});

test('flush with no new audio sends nothing; a missing final times out with an error', async () => {
  const { stt, log } = harness(50);
  await stt.start();
  const socket = FakeSocket.last!;
  await stt.flush();
  assert.equal(socket.sent.length, 0);
  stt.sendPcm(pcm16([1, 2]));
  await stt.flush();
  assert.deepEqual(log.errors, ['flush_timeout']);
});

test('events after stop are ignored', async () => {
  const { stt, log } = harness();
  await stt.start();
  const socket = FakeSocket.last!;
  await stt.stop();
  socket.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late', transcript: 'stale' });
  assert.deepEqual(log.transcripts, []);
});
