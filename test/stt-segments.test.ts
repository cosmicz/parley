import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SegmentStt } from '../src/stt-segments.ts';

const pcm = (ms: number, byte = 1): Uint8Array => new Uint8Array(ms * 32).fill(byte);

function setup(transcribe: (wav: Uint8Array) => Promise<string>, minSegmentMs = 300, maxSegmentMs = 15_000) {
  const texts: string[] = [];
  const states: string[] = [];
  const errors: { type: string; message: string }[] = [];
  const stt = new SegmentStt({ transcribe, minSegmentMs, maxSegmentMs }, {
    onTranscript: text => texts.push(text),
    onError: error => errors.push(error),
    onState: state => states.push(state),
  });
  return { stt, texts, states, errors };
}

test('flush sends a real segment, appends trimmed text, and emits current transcript for a short clip', async () => {
  const clips: Uint8Array[] = [];
  const { stt, texts, states } = setup(async wav => { clips.push(wav); return ' bonjour '; });
  await stt.start();
  const input = pcm(400, 7);
  stt.sendPcm(input);
  input.fill(9); // microphone may reuse its buffer before flush
  await stt.flush();
  assert.equal(clips.length, 1);
  assert.deepEqual(Array.from(clips[0].subarray(44, 48)), [7, 7, 7, 7]);
  stt.sendPcm(pcm(100));
  await stt.flush();
  assert.deepEqual(texts, ['bonjour', 'bonjour']);
  assert.deepEqual(states, ['open']);
});

test('keeps only newest maxSegmentMs of audio', async () => {
  const clips: Uint8Array[] = [];
  const { stt } = setup(async wav => { clips.push(wav); return 'oui'; }, 1, 400);
  await stt.start();
  stt.sendPcm(pcm(300, 1));
  stt.sendPcm(pcm(300, 2));
  await stt.flush();
  assert.equal(clips[0].byteLength, 44 + 400 * 32);
  assert.equal(clips[0][44], 1);
  assert.equal(clips[0][44 + 100 * 32], 2);
});

test('overlapping flushes preserve request and transcript order', async () => {
  const releases: ((text: string) => void)[] = [];
  const { stt, texts } = setup(() => new Promise(resolve => { releases.push(resolve); }), 1);
  await stt.start();
  stt.sendPcm(pcm(100, 1));
  const first = stt.flush();
  stt.sendPcm(pcm(100, 2));
  const second = stt.flush();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 1, 'second request waits for first');
  releases[0](' bonjour ');
  await first;
  assert.deepEqual(texts, [], 'older clip cannot release the coach awaiting the second clip');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 2);
  releases[1](' tout le monde ');
  await second;
  assert.deepEqual(texts, ['bonjour tout le monde']);
});

test('transcription errors release the coach and later clips still work', async () => {
  let calls = 0;
  const { stt, texts, errors } = setup(async () => {
    if (++calls === 1) throw new Error('service unavailable');
    return 'Salut';
  }, 1);
  await stt.start();
  stt.sendPcm(pcm(100));
  await stt.flush();
  stt.sendPcm(pcm(100));
  await stt.flush();
  assert.deepEqual(errors, [{ type: 'transcribe', message: 'service unavailable' }]);
  assert.deepEqual(texts, ['', 'Salut']);
});

test('a short newer flush releases the coach after the older clip completes', async () => {
  let release: (text: string) => void = () => {};
  const { stt, texts } = setup(() => new Promise(resolve => { release = resolve; }));
  await stt.start();
  stt.sendPcm(pcm(400));
  const first = stt.flush();
  const latest = stt.flush(); // a tap while the first clip is in flight
  await new Promise(resolve => setImmediate(resolve));
  release('bonjour');
  await first;
  await latest;
  assert.deepEqual(texts, ['bonjour']);
});

test('stop/start drops buffered audio and stale in-flight results', async () => {
  let release: (text: string) => void = () => {};
  const { stt, texts, states } = setup(() => new Promise(resolve => { release = resolve; }), 1);
  await stt.start();
  stt.sendPcm(pcm(100));
  const oldFlush = stt.flush();
  await new Promise(resolve => setImmediate(resolve));
  await stt.stop();
  await stt.start();
  release('stale');
  await oldFlush;
  await stt.flush();
  assert.deepEqual(texts, ['']);
  assert.deepEqual(states, ['open', 'closed', 'open']);
});
