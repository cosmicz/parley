// The suggestion contract: one short English continuation or an explicit
// abstain, never free text, and the prompt must carry what the model needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSuggestPrompt, parseSuggestion, MAX_SUGGESTION_CHARS } from '../src/suggest-core.ts';

test('prompt carries the transcript tail, the language pair and the trigger', () => {
  const p = buildSuggestPrompt({
    transcript: 'I need to hacer una cita um',
    practiceLanguage: 'en',
    fallbackLanguage: 'es',
    trigger: 'pause',
  });
  assert.match(p.user, /I need to hacer una cita um/);
  assert.match(p.system, /Spanish/);
  assert.match(p.system, /English/);
  assert.match(p.user, /pause/);
  assert.match(p.system, /abstain/);
});

test('prompt keeps only the tail of a long transcript', () => {
  const long = 'word '.repeat(200) + 'final words here';
  const p = buildSuggestPrompt({ transcript: long, practiceLanguage: 'en', fallbackLanguage: 'es', trigger: 'tap' });
  assert.ok(p.user.includes('final words here'));
  assert.ok(p.user.length < 600, `user prompt is ${p.user.length} chars`);
});

test('practice and fallback languages swap cleanly, e.g. French practice with English slips', () => {
  const p = buildSuggestPrompt({ transcript: 'Je voudrais un appointment', practiceLanguage: 'fr', fallbackLanguage: 'en', trigger: 'pause' });
  assert.match(p.system, /practising French and is stronger in English/);
  assert.match(p.system, /ONE short French phrase/);
});

test('prompt puts repairing a recent fallback-language slip before continuing', () => {
  const p = buildSuggestPrompt({ transcript: 'Je voudrais prendre un appointment euh', practiceLanguage: 'fr', fallbackLanguage: 'en', trigger: 'pause' });
  const repair = p.system.indexOf('First priority');
  const cont = p.system.indexOf('Otherwise');
  assert.ok(repair >= 0 && cont > repair, 'repair rule must come before the continuation rule');
  assert.match(p.system, /most recent English word or phrase/);
  assert.match(p.system, /even when French words or fillers follow them/);
});

test('parses a suggestion', () => {
  assert.deepEqual(parseSuggestion('{"suggestion": "make an appointment"}'), {
    kind: 'suggestion',
    text: 'make an appointment',
  });
});

test('parses a suggestion wrapped in a json code fence', () => {
  assert.deepEqual(parseSuggestion('```json\n{"suggestion": "make an appointment"}\n```'), {
    kind: 'suggestion',
    text: 'make an appointment',
  });
});

test('parses an abstain', () => {
  assert.deepEqual(parseSuggestion('{"abstain": true}'), { kind: 'abstain' });
});

test('rejects free text, empty and over-long suggestions', () => {
  assert.equal(parseSuggestion('make an appointment').kind, 'invalid');
  assert.equal(parseSuggestion('{"suggestion": "   "}').kind, 'invalid');
  assert.equal(parseSuggestion(JSON.stringify({ suggestion: 'x'.repeat(MAX_SUGGESTION_CHARS + 1) })).kind, 'invalid');
  assert.equal(parseSuggestion('{"other": 1}').kind, 'invalid');
});
