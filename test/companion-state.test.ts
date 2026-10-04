import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCoachState, reduceCoachState, resetCoachState } from '../src/companion-state.ts';

test('keeps spoken transcript separate from the proposed continuation', () => {
  const next = parseCoachState(JSON.stringify({
    transcript: 'Je voudrais parler de',
    suggestion: 'mon travail.',
    phase: 'suggesting',
    pauseToHudDispatchMs: 274,
  }));

  assert.deepEqual(next, {
    transcript: 'Je voudrais parler de',
    suggestion: 'mon travail.',
    phase: 'suggesting',
    pauseToHudDispatchMs: 274,
  });
  assert.equal(reduceCoachState(resetCoachState(), next).suggestion, 'mon travail.');
});

test('resumed speech and reset clear an old suggestion', () => {
  const showing = reduceCoachState(resetCoachState(), parseCoachState(JSON.stringify({
    transcript: 'Bonjour', suggestion: 'à tous.', phase: 'suggesting',
  })));
  const resumed = reduceCoachState(showing, parseCoachState(JSON.stringify({
    transcript: 'Bonjour, je', suggestion: 'stale', phase: 'listening',
  })));

  assert.equal(resumed.transcript, 'Bonjour, je');
  assert.equal(resumed.suggestion, null);
  assert.deepEqual(reduceCoachState(resumed, resetCoachState()), resetCoachState());
});

test('ignores malformed payloads and rejects invalid timing', () => {
  assert.equal(parseCoachState('{'), null);
  assert.equal(parseCoachState(JSON.stringify({ transcript: 1, phase: 'idle' })), null);
  assert.equal(parseCoachState(JSON.stringify({ transcript: '', phase: 'other' })), null);
  assert.equal(parseCoachState(JSON.stringify({
    transcript: 'Bonjour', phase: 'thinking', pauseToHudDispatchMs: -1,
  })), null);
});

test('idle clears transcript and suggestion even if stale fields arrive', () => {
  const next = reduceCoachState(resetCoachState(), parseCoachState(JSON.stringify({
    transcript: 'old', suggestion: 'old', phase: 'idle',
  })));
  assert.deepEqual(next, resetCoachState());
});
