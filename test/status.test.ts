// The status line is the wearer's and the audience's guide to what Parley is
// doing; each stage must say what is happening and what to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeStatus } from '../src/status.ts';

test('listening tells the wearer the language and how to get a hint', () => {
  const v = describeStatus({ stage: 'listening', language: 'French' });
  assert.equal(v.stage, 'listening');
  assert.match(v.text, /speak French/);
  assert.match(v.text, /pause about 1 s/);
});

test('calibrating asks for quiet', () => {
  assert.match(describeStatus({ stage: 'calibrating', language: 'French' }).text, /stay quiet/);
});

test('hint reports the pause-to-hint time in seconds when known', () => {
  assert.equal(describeStatus({ stage: 'hint', language: 'French', pauseToHintMs: 2345 }).text, 'Hint ready, 2.3 s after your pause');
  assert.equal(describeStatus({ stage: 'hint', language: 'French', pauseToHintMs: null }).text, 'Hint ready');
});

test('errors show the problem and the recovery', () => {
  const v = describeStatus({ stage: 'error', language: 'French', error: 'model call timed out' });
  assert.match(v.text, /model call timed out/);
  assert.match(v.text, /Reset/);
});
