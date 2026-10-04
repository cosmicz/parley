// Browser audio (Float32 at the device rate, often 48 or 44.1 kHz) to the
// 16 kHz mono s16le stream the glasses produce, so the laptop fallback feeds
// the same VAD and speech-to-text path.
//
// Downsampling first low-passes with a Hann-windowed sinc FIR (cutoff 7 kHz,
// below the 8 kHz Nyquist of the output) so room noise above 8 kHz does not
// fold into the speech band, then reads output samples by linear
// interpolation at fractional input positions. A one-pole IIR was considered
// and rejected: it cost about 1.5 dB at 3 kHz and only halved a 15 kHz alias.
// The FIR history, the fractional read position and the last filtered sample
// carry across push() calls, so any chunking yields byte-identical output.

const OUTPUT_RATE = 16000;
const CUTOFF_HZ = 7000;
// Taps per unit of rate ratio; 48 kHz gets 61 taps, a 30-sample (0.6 ms) delay.
const TAPS_PER_RATIO = 20;

export class Resampler16k {
  private readonly step: number;
  private readonly taps: Float32Array | null;
  private history: Float32Array;
  private position = 0;
  private previous = 0;

  constructor(inputRate: number) {
    if (!(inputRate > 0)) throw new RangeError(`invalid input rate ${inputRate}`);
    this.step = inputRate / OUTPUT_RATE;
    this.taps = inputRate > OUTPUT_RATE ? lowPassTaps(inputRate, CUTOFF_HZ, 2 * Math.round((TAPS_PER_RATIO * this.step) / 2) + 1) : null;
    this.history = new Float32Array(this.taps ? this.taps.length - 1 : 0);
  }

  push(input: Float32Array): Uint8Array {
    const n = input.length;
    if (n === 0) return new Uint8Array(0);
    const x = this.filter(input);

    // Output k reads input position `position + k * step`, where -1 refers to
    // the last sample of the previous chunk.
    const count = this.position <= n - 1 ? Math.floor((n - 1 - this.position) / this.step) + 1 : 0;
    const out = new Uint8Array(count * 2);
    const view = new DataView(out.buffer);
    for (let k = 0; k < count; k++) {
      const pos = this.position + k * this.step;
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i < 0 ? this.previous : x[i];
      const value = frac === 0 ? a : a + (x[i + 1] - a) * frac;
      view.setInt16(k * 2, toInt16(value), true);
    }
    this.position += count * this.step - n;
    this.previous = x[n - 1];
    return out;
  }

  private filter(input: Float32Array): Float32Array {
    const taps = this.taps;
    if (!taps) return input;
    const keep = this.history.length;
    const extended = new Float32Array(keep + input.length);
    extended.set(this.history);
    extended.set(input, keep);
    const out = new Float32Array(input.length);
    for (let k = 0; k < input.length; k++) {
      let acc = 0;
      for (let j = 0; j < taps.length; j++) acc += taps[j] * extended[k + j];
      out[k] = acc;
    }
    this.history = extended.slice(extended.length - keep);
    return out;
  }
}

function lowPassTaps(rate: number, cutoffHz: number, length: number): Float32Array {
  const taps = new Float32Array(length);
  const middle = (length - 1) / 2;
  const fc = cutoffHz / rate;
  let sum = 0;
  for (let i = 0; i < length; i++) {
    const t = i - middle;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (length - 1));
    taps[i] = sinc * hann;
    sum += taps[i];
  }
  // Unity gain at DC, so speech level is unchanged.
  for (let i = 0; i < length; i++) taps[i] /= sum;
  return taps;
}

function toInt16(value: number): number {
  const clipped = value >= 1 ? 1 : value <= -1 ? -1 : value;
  return clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767);
}
