import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav16kMono } from '../src/wav.ts';

test('encodes 16 kHz mono PCM16 in a 44-byte RIFF header and copies samples', () => {
  const original = new Uint8Array([0, 1, 255, 127]);
  const wav = encodeWav16kMono(original);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(wav.byteLength, 48);
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString(), 'RIFF');
  assert.equal(view.getUint32(4, true), 40);
  assert.equal(Buffer.from(wav.subarray(8, 12)).toString(), 'WAVE');
  assert.equal(Buffer.from(wav.subarray(12, 16)).toString(), 'fmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16_000);
  assert.equal(view.getUint32(28, true), 32_000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(Buffer.from(wav.subarray(36, 40)).toString(), 'data');
  assert.equal(view.getUint32(40, true), 4);
  assert.deepEqual(Array.from(wav.subarray(44)), [0, 1, 255, 127]);
  original.fill(9);
  assert.deepEqual(Array.from(wav.subarray(44)), [0, 1, 255, 127]);
});
