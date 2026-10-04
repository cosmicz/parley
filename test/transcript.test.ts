import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TranscriptAssembler } from '../src/transcript.ts';

test('final tokens accumulate once while provisional tokens are replaced', () => {
  const transcript = new TranscriptAssembler();
  assert.equal(transcript.apply({ tokens: [{ text: 'Je', is_final: true }, { text: ' suis', is_final: false }] }), 'Je suis');
  assert.equal(transcript.apply({ tokens: [{ text: ' voudrais', is_final: false }] }), 'Je voudrais');
  assert.equal(transcript.apply({ tokens: [{ text: ' voudrais', is_final: true }, { text: ' a coffee', is_final: false }] }), 'Je voudrais a coffee');
  assert.equal(transcript.apply({ tokens: [{ text: ' un café', is_final: false }] }), 'Je voudrais un café');
});

test('special tokens are skipped and reset removes prior finals and provisional text', () => {
  const transcript = new TranscriptAssembler();
  assert.equal(transcript.apply({ tokens: [
    { text: 'Bonjour', is_final: true },
    { text: '<end>', is_final: true },
    { text: ' tout', is_final: false },
    { text: '<fin>', is_final: false },
  ] }), 'Bonjour tout');
  transcript.reset();
  assert.equal(transcript.text, '');
  assert.equal(transcript.apply({ tokens: [{ text: 'Salut', is_final: true }] }), 'Salut');
});
