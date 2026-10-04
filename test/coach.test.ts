// The coach decides when to ask for a suggestion, when to drop a stale one and
// when to clear. These cases are the demo's acceptance rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coach, type CoachEffect } from '../src/coach.ts';
import type { VadEvent } from '../src/vad.ts';

const pause: VadEvent = { kind: 'pause', atMs: 2900, silenceStartedAtMs: 2000 };
const resume: VadEvent = { kind: 'resume', atMs: 3500, silenceStartedAtMs: 2000 };
const types = (effects: CoachEffect[]) => effects.map((e) => e.type);

function requestOf(effects: CoachEffect[]) {
  const r = effects.find((e) => e.type === 'request');
  assert.ok(r && r.type === 'request', 'expected a request effect');
  return r;
}

test('a pause after speech requests exactly one suggestion', () => {
  const c = new Coach();
  c.onTranscript('Je voudrais un appointment');
  const effects = c.onVad(pause, 10_000);
  assert.deepEqual(types(effects).filter((t) => t === 'request'), ['request']);
  assert.equal(requestOf(effects).trigger, 'pause');
  assert.equal(c.state.phase, 'thinking');
});

test('a pause with an empty transcript requests nothing', () => {
  const c = new Coach();
  assert.deepEqual(types(c.onVad(pause, 10_000)).filter((t) => t === 'request'), []);
});

test('a suggestion is shown, then cleared when speech resumes', () => {
  const c = new Coach();
  c.onTranscript('Je voudrais un appointment');
  const { seq } = requestOf(c.onVad(pause, 10_000));
  const shown = c.onSuggestion(seq, { kind: 'suggestion', text: 'prendre un rendez-vous' });
  assert.deepEqual(shown.find((e) => e.type === 'show-suggestion'), { type: 'show-suggestion', seq, text: 'prendre un rendez-vous' });
  assert.equal(c.state.suggestion, 'prendre un rendez-vous');
  const cleared = c.onVad(resume, 11_000);
  assert.deepEqual(cleared.find((e) => e.type === 'show-suggestion'), { type: 'show-suggestion', seq: null, text: '' });
  assert.equal(c.state.suggestion, null);
  assert.equal(c.state.phase, 'listening');
});

test('a result that arrives after speech resumed is discarded', () => {
  const c = new Coach();
  c.onTranscript('Je voudrais un appointment');
  const { seq } = requestOf(c.onVad(pause, 10_000));
  c.onVad(resume, 10_300);
  assert.deepEqual(c.onSuggestion(seq, { kind: 'suggestion', text: 'trop tard' }), []);
  assert.equal(c.state.suggestion, null);
});

test('an abstain shows nothing and returns to listening', () => {
  const c = new Coach();
  c.onTranscript('euh');
  const { seq } = requestOf(c.onVad(pause, 10_000));
  const effects = c.onSuggestion(seq, { kind: 'abstain' });
  assert.equal(effects.some((e) => e.type === 'show-suggestion'), false);
  assert.equal(c.state.phase, 'listening');
});

test('latency runs from the start of the silence to the HUD dispatch', () => {
  const c = new Coach();
  c.onTranscript('Je voudrais un appointment');
  // The pause event fires at audio 2900 ms for silence that began at 2000 ms,
  // observed at wall 10000 ms, so the silence began at wall 9100 ms.
  const { seq } = requestOf(c.onVad(pause, 10_000));
  c.onSuggestion(seq, { kind: 'suggestion', text: 'un rendez-vous' });
  c.onDispatched(seq, 10_500);
  assert.equal(c.state.pauseToHudDispatchMs, 1400);
});

test('a tap asks for help immediately and supersedes a pending request', () => {
  const c = new Coach();
  c.onTranscript('Je voudrais un appointment');
  const first = requestOf(c.onVad(pause, 10_000));
  const tap = requestOf(c.onHelp(10_200));
  assert.equal(tap.trigger, 'tap');
  assert.notEqual(tap.seq, first.seq);
  assert.deepEqual(c.onSuggestion(first.seq, { kind: 'suggestion', text: 'old' }), []);
});

test('reset clears transcript, suggestion and latency', () => {
  const c = new Coach();
  c.onTranscript('Je voudrais un appointment');
  const { seq } = requestOf(c.onVad(pause, 10_000));
  c.onSuggestion(seq, { kind: 'suggestion', text: 'un rendez-vous' });
  c.onDispatched(seq, 10_500);
  c.reset();
  assert.deepEqual(c.state, { transcript: '', suggestion: null, phase: 'idle', pauseToHudDispatchMs: null });
});

// Clip transcription (no streaming STT): the transcript for an utterance only
// exists after the pause, so the coach waits for it before asking.
test('in transcript-wait mode a pause requests only after the clip transcript arrives', () => {
  const c = new Coach({ waitForTranscript: true });
  const atPause = c.onVad(pause, 10_000);
  assert.deepEqual(types(atPause).filter((t) => t === 'request'), []);
  assert.equal(c.state.phase, 'thinking');
  const r = requestOf(c.onTranscript('Je voudrais un appointment'));
  assert.equal(r.trigger, 'pause');
  assert.equal(r.transcript, 'Je voudrais un appointment');
  c.onSuggestion(r.seq, { kind: 'suggestion', text: 'un rendez-vous' });
  c.onDispatched(r.seq, 12_000);
  // Silence began at wall 9100 ms, so transcription time counts toward latency.
  assert.equal(c.state.pauseToHudDispatchMs, 2900);
});

test('in transcript-wait mode speech resuming before the transcript cancels the request', () => {
  const c = new Coach({ waitForTranscript: true });
  c.onVad(pause, 10_000);
  c.onVad(resume, 10_400);
  assert.deepEqual(types(c.onTranscript('Je voudrais')).filter((t) => t === 'request'), []);
});

test('in transcript-wait mode a tap also waits for the transcript', () => {
  const c = new Coach({ waitForTranscript: true });
  assert.deepEqual(types(c.onHelp(10_000)).filter((t) => t === 'request'), []);
  assert.equal(requestOf(c.onTranscript('Je cherche le')).trigger, 'tap');
});

test('in transcript-wait mode an empty transcript after a pause returns to listening', () => {
  const c = new Coach({ waitForTranscript: true });
  c.onVad(pause, 10_000);
  assert.deepEqual(types(c.onTranscript('')).filter((t) => t === 'request'), []);
  assert.equal(c.state.phase, 'idle');
});

test('partial (streaming) text updates the transcript but never fulfils an awaited request', () => {
  const c = new Coach({ waitForTranscript: true });
  c.onVad(pause, 10_000);
  assert.deepEqual(types(c.onPartial('Je voudrais un appoint')).filter((t) => t === 'request'), []);
  assert.equal(c.state.transcript, 'Je voudrais un appoint');
  assert.equal(requestOf(c.onTranscript('Je voudrais un appointment')).transcript, 'Je voudrais un appointment');
});
