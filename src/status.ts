// One plain-language status line for the phone and laptop page, so the wearer
// (and an audience) always knows what Parley is doing and what to do next.

export type Stage = 'starting' | 'calibrating' | 'listening' | 'transcribing' | 'thinking' | 'hint' | 'error';

export interface StatusInput {
  stage: Stage;
  /** Human name of the practised language, e.g. "French". */
  language: string;
  /** Error text, for the error stage. */
  error?: string;
  /** App-side time from pause start to the hint being sent to the HUD. */
  pauseToHintMs?: number | null;
}

export interface StatusView {
  stage: Stage;
  text: string;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export function describeStatus(input: StatusInput): StatusView {
  const { stage, language } = input;
  switch (stage) {
    case 'starting':
      return { stage, text: 'Starting…' };
    case 'calibrating':
      return { stage, text: 'Calibrating: stay quiet for a second' };
    case 'listening':
      return { stage, text: `Listening: speak ${language}, pause about 1 s for a hint` };
    case 'transcribing':
      return { stage, text: 'Heard you: transcribing…' };
    case 'thinking':
      return { stage, text: 'Finding the words…' };
    case 'hint':
      return {
        stage,
        text: input.pauseToHintMs != null ? `Hint ready, ${seconds(input.pauseToHintMs)} after your pause` : 'Hint ready',
      };
    case 'error':
      return { stage, text: `Problem: ${input.error ?? 'unknown error'}. Keep talking, or press Reset.` };
  }
}
