// Pause detection over raw 16 kHz s16le PCM from the G2 microphone.
//
// Why raw audio rather than speech-to-text: STT models may drop fillers and
// their endpointing is tuned for dictation, while the coach needs a precise
// "the speaker stalled" signal. A noise floor calibrated in the first second
// keeps a noisy hall from reading as speech; the floor then adapts slowly on
// silence windows only, so it cannot creep up into the speaker's voice.

export type VadEventKind = 'speech-start' | 'pause' | 'resume';

export interface VadEvent {
  kind: VadEventKind;
  /** Audio time (ms since the detector started) when the event fired. */
  atMs: number;
  /** Audio time when the silence preceding this event began. */
  silenceStartedAtMs: number;
}

export interface VadOptions {
  sampleRate: number;
  windowMs: number;
  calibrationMs: number;
  /** Speech threshold as a multiple of the calibrated noise floor (RMS). */
  speechFactor: number;
  /** Absolute RMS floor for the threshold, for near-silent rooms. */
  minSpeechRms: number;
  /** Consecutive speech needed to count as speech (rejects clicks). */
  minSpeechMs: number;
  /** Silence after speech that counts as a pause (Cue used 900 ms). */
  pauseMs: number;
  /** Weight of each silence window in the adaptive noise floor. */
  floorAdaptRate: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = {
  sampleRate: 16000,
  windowMs: 20,
  calibrationMs: 1000,
  speechFactor: 3,
  minSpeechRms: 200,
  minSpeechMs: 120,
  pauseMs: 900,
  floorAdaptRate: 0.02,
};

type Phase = 'calibrating' | 'idle' | 'speaking' | 'paused';

export class PauseDetector {
  readonly options: VadOptions;
  private readonly windowSamples: number;
  private readonly window: Int16Array;
  private windowFill = 0;
  private windowsSeen = 0;
  private phase: Phase = 'calibrating';
  private calibrationSum = 0;
  private calibrationWindows = 0;
  private floor = 0;
  private consecutiveSpeech = 0;
  private silenceStartMs = 0;

  constructor(options: Partial<VadOptions> = {}) {
    this.options = { ...DEFAULT_VAD_OPTIONS, ...options };
    this.windowSamples = Math.round((this.options.sampleRate * this.options.windowMs) / 1000);
    this.window = new Int16Array(this.windowSamples);
  }

  get noiseFloor(): number {
    return this.floor;
  }

  get threshold(): number {
    return Math.max(this.floor * this.options.speechFactor, this.options.minSpeechRms);
  }

  get state(): Phase {
    return this.phase;
  }

  reset(): void {
    this.windowFill = 0;
    this.windowsSeen = 0;
    this.phase = 'calibrating';
    this.calibrationSum = 0;
    this.calibrationWindows = 0;
    this.floor = 0;
    this.consecutiveSpeech = 0;
    this.silenceStartMs = 0;
  }

  /** Feed samples of any length; returns the events they complete. */
  push(samples: Int16Array): VadEvent[] {
    const events: VadEvent[] = [];
    let i = 0;
    while (i < samples.length) {
      const take = Math.min(this.windowSamples - this.windowFill, samples.length - i);
      this.window.set(samples.subarray(i, i + take), this.windowFill);
      this.windowFill += take;
      i += take;
      if (this.windowFill === this.windowSamples) {
        this.windowFill = 0;
        this.windowsSeen += 1;
        const event = this.onWindow(rms(this.window));
        if (event) events.push(event);
      }
    }
    return events;
  }

  private onWindow(level: number): VadEvent | null {
    const o = this.options;
    const nowMs = (this.windowsSeen * this.windowSamples * 1000) / o.sampleRate;

    if (this.phase === 'calibrating') {
      this.calibrationSum += level;
      this.calibrationWindows += 1;
      if (nowMs >= o.calibrationMs) {
        this.floor = this.calibrationSum / this.calibrationWindows;
        this.phase = 'idle';
        this.silenceStartMs = nowMs;
      }
      return null;
    }

    const minSpeechWindows = Math.ceil(o.minSpeechMs / o.windowMs);
    if (level >= this.threshold) {
      this.consecutiveSpeech += 1;
      if (this.consecutiveSpeech < minSpeechWindows) return null;
      const silenceStartedAtMs = this.silenceStartMs;
      this.silenceStartMs = nowMs; // speech is ongoing; silence restarts after it
      if (this.phase === 'idle') {
        this.phase = 'speaking';
        return { kind: 'speech-start', atMs: nowMs, silenceStartedAtMs };
      }
      if (this.phase === 'paused') {
        this.phase = 'speaking';
        return { kind: 'resume', atMs: nowMs, silenceStartedAtMs };
      }
      return null;
    }

    this.consecutiveSpeech = 0;
    this.floor += (level - this.floor) * o.floorAdaptRate;
    if (this.phase === 'speaking' && nowMs - this.silenceStartMs >= o.pauseMs) {
      this.phase = 'paused';
      return { kind: 'pause', atMs: nowMs, silenceStartedAtMs: this.silenceStartMs };
    }
    return null;
  }
}

function rms(window: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < window.length; i++) sum += window[i] * window[i];
  return Math.sqrt(sum / window.length);
}

/** Decode little-endian s16 PCM bytes; a trailing odd byte is dropped. */
export function pcmBytesToInt16(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Int16Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}
