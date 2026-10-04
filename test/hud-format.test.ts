// The HUD is 576x288 and monochrome: the transcript must show its newest words
// (foreign words intact) and the suggestion must be visibly marked as one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTranscript, formatSuggestion, TRANSCRIPT_LINES, LINE_CHARS } from '../src/hud-format.ts';

test('transcript keeps the newest words and wraps to the line budget', () => {
  const text = 'one two three four five six seven eight nine ten '.repeat(10) + 'I need to hacer una cita';
  const out = formatTranscript(text);
  const lines = out.split('\n');
  assert.ok(lines.length <= TRANSCRIPT_LINES, `${lines.length} lines`);
  for (const l of lines) assert.ok(l.length <= LINE_CHARS, `line too long: ${l}`);
  assert.ok(out.endsWith('I need to hacer una cita'), out);
});

test('transcript keeps non-ASCII foreign words intact', () => {
  assert.equal(formatTranscript('quiero una canción, señor'), 'quiero una canción, señor');
});

test('suggestion is prefixed so it cannot be mistaken for transcript', () => {
  assert.equal(formatSuggestion('make an appointment'), '> make an appointment');
  assert.equal(formatSuggestion(null), '');
});
