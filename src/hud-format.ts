// Text layout for the 576x288 monochrome HUD.
//
// The transcript container shows the newest words, word-wrapped from the end,
// so the latest speech is always visible. The suggestion line carries an ASCII
// marker (Unicode glyphs render unreliably on the G2) so it cannot be mistaken
// for transcript. Budgets are conservative until checked on the device.

export const LINE_CHARS = 32;
export const TRANSCRIPT_LINES = 4;

export function formatTranscript(text: string, lines = TRANSCRIPT_LINES, width = LINE_CHARS): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const out: string[] = [];
  let current = '';
  for (let i = words.length - 1; i >= 0 && out.length < lines; i--) {
    let word = words[i];
    // Hard-split words longer than a line, keeping their tail.
    while (word.length > width) {
      if (current) { out.unshift(current); current = ''; if (out.length >= lines) break; }
      out.unshift(word.slice(word.length - width));
      word = word.slice(0, word.length - width);
      if (out.length >= lines) break;
    }
    if (out.length >= lines) break;
    if (!current) current = word;
    else if (word.length + 1 + current.length <= width) current = `${word} ${current}`;
    else {
      out.unshift(current);
      current = out.length < lines ? word : '';
    }
  }
  if (current && out.length < lines) out.unshift(current);
  return out.join('\n');
}

export function formatSuggestion(suggestion: string | null): string {
  return suggestion ? `> ${suggestion}` : '';
}
