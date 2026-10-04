import type { SttCallbacks } from './stt-soniox.ts';
import { encodeWav16kMono } from './wav.ts';

const BYTES_PER_MS = 16_000 * 2 / 1_000;

export interface SegmentSttOptions {
  transcribe: (wav: Uint8Array) => Promise<string>;
  minSegmentMs?: number;
  maxSegmentMs?: number;
}

/** Groups raw microphone PCM by pause and serializes clip transcription. */
export class SegmentStt {
  private chunks: Uint8Array[] = [];
  private bufferedBytes = 0;
  private transcript = '';
  private queue: Promise<void> = Promise.resolve();
  private generation = 0;
  private open = false;
  private readonly opts: SegmentSttOptions;
  private readonly cb: SttCallbacks;

  constructor(opts: SegmentSttOptions, cb: SttCallbacks) {
    this.opts = opts;
    this.cb = cb;
  }

  async start(): Promise<void> {
    ++this.generation;
    this.chunks = [];
    this.bufferedBytes = 0;
    this.transcript = '';
    this.queue = Promise.resolve();
    this.open = true;
    this.cb.onState('open');
  }

  sendPcm(bytes: Uint8Array): void {
    if (!this.open) return;
    const evenLength = bytes.byteLength - bytes.byteLength % 2;
    if (!evenLength) return;
    const maxBytes = Math.max(0, Math.floor((this.opts.maxSegmentMs ?? 15_000) * BYTES_PER_MS / 2) * 2);
    if (!maxBytes) return;
    // Copy now: the microphone bridge may recycle the source backing store.
    const copy = bytes.slice(0, evenLength);
    this.chunks.push(copy);
    this.bufferedBytes += copy.byteLength;
    while (this.bufferedBytes > maxBytes) {
      const oldest = this.chunks[0];
      const excess = this.bufferedBytes - maxBytes;
      if (oldest.byteLength <= excess) {
        this.chunks.shift();
        this.bufferedBytes -= oldest.byteLength;
      } else {
        this.chunks[0] = oldest.slice(excess);
        this.bufferedBytes -= excess;
      }
    }
  }

  flush(): Promise<void> {
    if (!this.open) return Promise.resolve();
    const pcm = new Uint8Array(this.bufferedBytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      pcm.set(chunk, offset);
      offset += chunk.byteLength;
    }
    this.chunks = [];
    this.bufferedBytes = 0;
    const generation = this.generation;
    const work = async () => {
      if (generation !== this.generation || !this.open) return;
      if (pcm.byteLength < (this.opts.minSegmentMs ?? 300) * BYTES_PER_MS) {
        this.cb.onTranscript(this.transcript);
        return;
      }
      try {
        const text = (await this.opts.transcribe(encodeWav16kMono(pcm))).trim();
        if (generation !== this.generation || !this.open) return;
        if (text) this.transcript = this.transcript ? `${this.transcript} ${text}` : text;
      } catch (error) {
        if (generation !== this.generation || !this.open) return;
        this.cb.onError({ type: 'transcribe', message: error instanceof Error ? error.message : String(error) });
      }
      this.cb.onTranscript(this.transcript);
    };
    this.queue = this.queue.then(work, work);
    return this.queue;
  }

  async stop(): Promise<void> {
    ++this.generation;
    this.open = false;
    this.chunks = [];
    this.bufferedBytes = 0;
    this.cb.onState('closed');
  }
}
