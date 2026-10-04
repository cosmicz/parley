// Prompt and output contract for the coach's one-line suggestion.
//
// The model must return strict JSON: one short continuation in the language the
// wearer is practising, or an explicit abstain. Anything else is rejected so the HUD never shows free text,
// and the prompt forbids inventing facts the speaker has not said.

export const MAX_SUGGESTION_CHARS = 48;
const TAIL_CHARS = 300;

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  ro: 'Romanian',
  fr: 'French',
  pt: 'Portuguese',
  it: 'Italian',
  de: 'German',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
  hi: 'Hindi',
  ru: 'Russian',
};

export type Trigger = 'pause' | 'tap';

export interface SuggestInput {
  transcript: string;
  /** ISO 639-1 code of the language the wearer is speaking and practising; suggestions come in it. */
  practiceLanguage: string;
  /** ISO 639-1 code of the stronger language the wearer slips into when stuck. */
  fallbackLanguage: string;
  trigger: Trigger;
}

export const languageName = (code: string): string => LANGUAGE_NAMES[code] ?? code;

export interface SuggestPrompt {
  system: string;
  user: string;
}

export type SuggestResult =
  | { kind: 'suggestion'; text: string }
  | { kind: 'abstain' }
  | { kind: 'invalid'; reason: string };

export function transcriptTail(transcript: string, maxChars = TAIL_CHARS): string {
  const clean = transcript.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(clean.length - maxChars);
  const firstSpace = cut.indexOf(' ');
  return firstSpace > 0 ? cut.slice(firstSpace + 1) : cut;
}

export function buildSuggestPrompt(input: SuggestInput): SuggestPrompt {
  const practice = languageName(input.practiceLanguage);
  const fallback = languageName(input.fallbackLanguage);
  const system = [
    `You are a discreet ${practice} conversation coach whose words appear on smart glasses.`,
    `The wearer is practising ${practice} and is stronger in ${fallback}. The live transcript may mix in ${fallback} words, fillers such as "um", and speech-recognition errors.`,
    `Give ONE short ${practice} phrase for the wearer.`,
    `First priority: if there are ${fallback} words near the end of the transcript, reply with the ${practice} for those words, in the form that fits the sentence (for example the ${practice} noun with its article).`,
    `Otherwise, give the natural ${practice} continuation of their sentence.`,
    `At most 6 words and ${MAX_SUGGESTION_CHARS} characters. Do not invent names, times, places or reasons the wearer has not said.`,
    `If the transcript gives no basis for a continuation, reply with a neutral ${practice} bridge phrase (in English that would be "Let me put it another way"), or abstain.`,
    `Reply with JSON only: {"suggestion": "..."} or {"abstain": true}.`,
  ].join('\n');
  const user = `Trigger: ${input.trigger}\nTranscript, most recent last:\n"${transcriptTail(input.transcript)}"`;
  return { system, user };
}

export function parseSuggestion(raw: string): SuggestResult {
  const body = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  if (typeof value !== 'object' || value === null) return { kind: 'invalid', reason: 'not an object' };
  const obj = value as Record<string, unknown>;
  if (obj.abstain === true) return { kind: 'abstain' };
  if (typeof obj.suggestion !== 'string') return { kind: 'invalid', reason: 'no suggestion field' };
  const text = obj.suggestion.trim();
  if (text.length === 0) return { kind: 'invalid', reason: 'empty suggestion' };
  if (text.length > MAX_SUGGESTION_CHARS) return { kind: 'invalid', reason: 'suggestion too long' };
  return { kind: 'suggestion', text };
}
