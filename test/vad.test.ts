// Pause detection is the product's trigger, so these tests pin its contract on
// synthetic 16 kHz audio: calibrate on room noise, fire exactly one pause after
// ~900 ms of silence that follows speech, and report resumed speech.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PauseDetector, pcmBytesToInt16, type VadEvent } from '../src/vad.ts';

const RATE = 16000;

// Deterministic pseudo-random noise so runs are reproducible.
function noise(ms: number, amplitude: number, seed = 1): Int16Array {
  const n = Math.round((RATE * ms) / 1000);
  const out = new Int16Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = Math.round(((s / 0xffffffff) * 2 - 1) * amplitude);
  }
  return out;
}

function tone(ms: number, amplitude: number): Int16Array {
  const n = Math.round((RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * amplitude);
  return out;
}

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function feed(det: PauseDetector, audio: Int16Array, chunk: number): VadEvent[] {
  const events: VadEvent[] = [];
  for (let i = 0; i < audio.length; i += chunk) events.push(...det.push(audio.subarray(i, i + chunk)));
  return events;
}

const kinds = (events: VadEvent[]) => events.map((e) => e.kind);

test('speech, 1.2 s silence, speech yields speech-start, one pause, one resume', () => {
  const audio = concat(noise(1000, 100), tone(1000, 5000), noise(1200, 100, 7), tone(500, 5000));
  const events = feed(new PauseDetector(), audio, 160);
  assert.deepEqual(kinds(events), ['speech-start', 'pause', 'resume']);
  const pause = events[1];
  // Speech ends at 2000 ms; the pause fires once 900 ms of silence has accrued.
  assert.ok(pause.atMs >= 2880 && pause.atMs <= 2960, `pause at ${pause.atMs}`);
  assert.ok(pause.silenceStartedAtMs >= 1980 && pause.silenceStartedAtMs <= 2040, `silence from ${pause.silenceStartedAtMs}`);
});

test('no pause fires before the silence threshold', () => {
  const audio = concat(noise(1000, 100), tone(1000, 5000), noise(800, 100, 3));
  assert.deepEqual(kinds(feed(new PauseDetector(), audio, 160)), ['speech-start']);
});

test('steady background noise matching the calibration is not speech', () => {
  const audio = concat(noise(1000, 800, 5), noise(3000, 800, 9));
  assert.deepEqual(feed(new PauseDetector(), audio, 160), []);
});

test('events do not depend on chunk size', () => {
  const audio = concat(noise(1000, 100), tone(1000, 5000), noise(1200, 100, 7), tone(500, 5000));
  const a = feed(new PauseDetector(), audio, 37);
  const b = feed(new PauseDetector(), audio, 1600);
  assert.deepEqual(a, b);
});

test('a short click does not count as speech', () => {
  const audio = concat(noise(1000, 100), tone(60, 5000), noise(1500, 100, 11));
  assert.deepEqual(feed(new PauseDetector(), audio, 160), []);
});

test('pcmBytesToInt16 decodes little-endian samples at any byte offset', () => {
  const backing = new Uint8Array([0xff, 0x01, 0x00, 0xff, 0x7f, 0x00, 0x80]);
  const view = backing.subarray(1); // odd offset: 01 00 | ff 7f | 00 80
  assert.deepEqual(Array.from(pcmBytesToInt16(view)), [1, 32767, -32768]);
});
