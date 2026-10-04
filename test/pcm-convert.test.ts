// The laptop fallback feeds the same 16 kHz s16le pipeline as the glasses, so
// the resampler must keep duration, level and continuity whatever the
// browser's native rate and however the audio callback splits the stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Resampler16k } from '../src/pcm-convert.ts';

const samples = (bytes: Uint8Array): Int16Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(bytes.byteLength / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
};

const sine = (rate: number, seconds: number, hz: number, amplitude: number): Float32Array => {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
};

const pushInChunks = (r: Resampler16k, input: Float32Array, sizes: number[]): Uint8Array => {
  const parts: Uint8Array[] = [];
  for (let at = 0, k = 0; at < input.length; k++) {
    const size = sizes[k % sizes.length];
    parts.push(r.push(input.subarray(at, at + size)));
    at += size;
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

for (const rate of [48000, 44100]) {
  test(`one second at ${rate} Hz becomes one second at 16 kHz, as 16-bit little-endian`, () => {
    const out = new Resampler16k(rate).push(sine(rate, 1, 440, 0.5));
    assert.equal(out.byteLength % 2, 0);
    assert.ok(Math.abs(out.byteLength / 2 - 16000) <= 1, `got ${out.byteLength / 2} samples`);
  });
}

test('16 kHz input passes through sample for sample', () => {
  const input = Float32Array.from([0, 0.5, -0.5, 1, -1]);
  assert.deepEqual(Array.from(samples(new Resampler16k(16000).push(input))), [0, 16384, -16384, 32767, -32768]);
});

test('speech-band level is preserved: 0.5 amplitude tones at 440 Hz and 3.4 kHz peak near 16384', () => {
  for (const rate of [48000, 44100]) {
    for (const hz of [440, 3400]) {
      const out = samples(new Resampler16k(rate).push(sine(rate, 0.5, hz, 0.5)));
      const peak = out.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
      assert.ok(peak > 15500 && peak < 16800, `${rate} Hz input, ${hz} Hz tone: peak ${peak}`);
    }
  }
});

test('out-of-range input is clipped to full scale instead of wrapping', () => {
  const out = samples(new Resampler16k(48000).push(new Float32Array(480).fill(3)));
  assert.equal(out.length, 160);
  assert.ok(out.slice(25).every((s) => s === 32767), `max ${Math.max(...out)}, min ${Math.min(...out)}`);
  const neg = samples(new Resampler16k(48000).push(new Float32Array(480).fill(-3)));
  assert.ok(neg.slice(25).every((s) => s === -32768), `min ${Math.min(...neg)}`);
});

test('the stream is continuous: any chunking gives the same bytes as one push', () => {
  for (const rate of [48000, 44100]) {
    const input = sine(rate, 0.3, 523, 0.8);
    const whole = new Resampler16k(rate).push(input);
    for (const sizes of [[128], [127, 1, 300], [1], [441, 7, 0, 64]]) {
      const split = pushInChunks(new Resampler16k(rate), input, sizes);
      assert.deepEqual(split, whole, `${rate} Hz split by ${sizes.join(',')}`);
    }
  }
});

test('high frequencies are attenuated before decimation to limit aliasing', () => {
  // 15 kHz at 48 kHz aliases to 1 kHz at 16 kHz without a low-pass.
  const tone = samples(new Resampler16k(48000).push(sine(48000, 0.2, 15000, 0.5)));
  const peak = tone.slice(50).reduce((m, s) => Math.max(m, Math.abs(s)), 0);
  assert.ok(peak < 0.05 * 16384, `aliased peak ${peak}`);
});

test('a steady level passes at exactly unity gain once the filter has settled', () => {
  for (const rate of [48000, 44100]) {
    const out = samples(new Resampler16k(rate).push(new Float32Array(rate / 10).fill(0.25)));
    assert.ok(out.slice(25).every((s) => s === 8192), `${rate} Hz: ${[...new Set(out.slice(25))].join(',')}`);
  }
});
