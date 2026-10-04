// OpenAI realtime transcription (gpt-live-transcribe) as a streaming STT
// source: partial text while the wearer speaks, a final transcript per turn
// when the pause detector commits it. Spike behind REALTIME_STT=1 (pahax-g2x).
//
// Per developers.openai.com (read 2026-10-04): the browser authenticates with
// an ephemeral client secret passed as the WebSocket subprotocol
// 'openai-insecure-api-key.<ek_...>' next to 'realtime'; audio goes up as
// base64 PCM16 in input_audio_buffer.append at the session rate (24 kHz);
// the model has no server VAD, so each turn ends with input_audio_buffer.commit.
// Events: conversation.item.input_audio_transcription.delta { item_id, delta }
// and .completed { item_id, transcript }; completions of different turns may
// arrive out of order, so text is keyed by item_id. The WebSocket URL for a
// session preconfigured by a client secret is not spelled out in the docs;
// DEFAULT_URL is an assumption to confirm on the first live run.

import type { SttCallbacks } from './stt-soniox.ts';

export const DEFAULT_URL = 'wss://api.openai.com/v1/realtime';
const INPUT_RATE = 16_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 2_500;

export interface RealtimeSttOptions {
  /** Fetches GET /api/realtime-token from the app server. */
  getToken: () => Promise<{ apiKey: string; sampleRate: number }>;
  url?: string;
  flushTimeoutMs?: number;
}

export interface RealtimeSttCallbacks extends SttCallbacks {
  /** Display only: committed text plus the turn in progress. Never feed the coach. */
  onPartial?(text: string): void;
}

interface ServerEvent {
  type: string;
  item_id?: string;
  delta?: string;
  transcript?: string;
  error?: { type?: string; message?: string };
}

export class RealtimeStt {
  private socket: WebSocket | null = null;
  private resampler: LinearPcm16Resampler | null = null;
  private generation = 0;
  private uncommitted = false;
  /** Item ids in commit order, with their final text once completed. */
  private readonly order: string[] = [];
  private readonly finals = new Map<string, string>();
  private readonly partials = new Map<string, string>();
  private readonly waiters = new Map<string, () => void>();
  private pendingCommit: ((itemId: string) => void) | null = null;
  private readonly opts: RealtimeSttOptions;
  private readonly cb: RealtimeSttCallbacks;
  private readonly WebSocketCtor: typeof WebSocket;

  constructor(opts: RealtimeSttOptions, cb: RealtimeSttCallbacks, WebSocketCtor: typeof WebSocket = WebSocket) {
    this.opts = opts;
    this.cb = cb;
    this.WebSocketCtor = WebSocketCtor;
  }

  async start(): Promise<void> {
    this.close();
    const generation = ++this.generation;
    this.order.length = 0;
    this.finals.clear();
    this.partials.clear();
    this.uncommitted = false;
    this.cb.onState('connecting');
    const token = await this.opts.getToken();
    if (generation !== this.generation) return;
    this.resampler = new LinearPcm16Resampler(INPUT_RATE, token.sampleRate);
    const socket = new this.WebSocketCtor(this.opts.url ?? DEFAULT_URL, ['realtime', `openai-insecure-api-key.${token.apiKey}`]);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error('realtime transcription socket failed to open'));
    });
    if (generation !== this.generation) return;
    socket.onerror = () => this.cb.onError({ type: 'socket_error', message: 'realtime transcription socket error' });
    socket.onclose = () => {
      if (generation === this.generation) this.cb.onState('closed');
    };
    socket.onmessage = (event: MessageEvent) => {
      if (generation === this.generation) this.handle(String(event.data));
    };
    this.cb.onState('open');
  }

  sendPcm(bytes: Uint8Array): void {
    if (!this.socket || this.socket.readyState !== this.WebSocketCtor.OPEN || !this.resampler) return;
    const pcm = this.resampler.push(bytes);
    if (pcm.byteLength === 0) return;
    this.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: toBase64(pcm) }));
    this.uncommitted = true;
  }

  /** Ends the current turn; resolves once its final transcript arrived or after the timeout. */
  async flush(): Promise<void> {
    if (!this.socket || !this.uncommitted) return;
    const generation = this.generation;
    this.uncommitted = false;
    const timeoutMs = this.opts.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const done = (async () => {
      const itemId = await new Promise<string>((resolve) => {
        this.pendingCommit = resolve;
        this.socket?.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      });
      if (this.finals.has(itemId)) return 'done' as const;
      await new Promise<void>((resolve) => this.waiters.set(itemId, resolve));
      return 'done' as const;
    })();
    const outcome = await Promise.race([done, timeout]);
    clearTimeout(timer);
    if (generation !== this.generation) return;
    if (outcome === 'timeout') {
      this.pendingCommit = null;
      this.cb.onError({ type: 'flush_timeout', message: `no final transcript within ${timeoutMs} ms` });
    }
  }

  async stop(): Promise<void> {
    this.generation++;
    this.close();
  }

  private close(): void {
    this.pendingCommit = null;
    this.waiters.clear();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
      this.cb.onState('closed');
    }
  }

  private handle(raw: string): void {
    let event: ServerEvent;
    try {
      event = JSON.parse(raw) as ServerEvent;
    } catch {
      this.cb.onError({ type: 'invalid_response', message: 'realtime transcription sent invalid JSON' });
      return;
    }
    const id = event.item_id;
    switch (event.type) {
      case 'input_audio_buffer.committed':
        if (id && !this.order.includes(id)) this.order.push(id);
        if (id) this.pendingCommit?.(id);
        this.pendingCommit = null;
        break;
      case 'conversation.item.input_audio_transcription.delta':
        if (!id) break;
        this.partials.set(id, (this.partials.get(id) ?? '') + (event.delta ?? ''));
        this.cb.onPartial?.(this.text(true));
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (!id) break;
        if (!this.order.includes(id)) this.order.push(id);
        this.finals.set(id, (event.transcript ?? '').trim());
        this.partials.delete(id);
        this.cb.onTranscript(this.text(false));
        this.waiters.get(id)?.();
        this.waiters.delete(id);
        break;
      case 'conversation.item.input_audio_transcription.failed':
        if (!id) break;
        this.partials.delete(id);
        this.cb.onError({ type: 'transcription_failed', message: event.error?.message ?? 'transcription failed' });
        this.waiters.get(id)?.();
        this.waiters.delete(id);
        break;
      case 'error':
        this.cb.onError({ type: event.error?.type ?? 'error', message: event.error?.message ?? 'realtime transcription error' });
        break;
      default:
        break;
    }
  }

  /** Final turns in commit order; with partials, also the turns still in progress. */
  private text(withPartials: boolean): string {
    const parts = this.order.map((id) => this.finals.get(id) ?? (withPartials ? this.partials.get(id) : undefined));
    if (withPartials) for (const [id, partial] of this.partials) if (!this.order.includes(id)) parts.push(partial);
    return parts.filter((p): p is string => !!p && p.trim().length > 0).map((p) => p.trim()).join(' ');
  }
}

/** Linear-interpolation resampler for s16le PCM, continuous across chunks. */
export class LinearPcm16Resampler {
  private readonly step: number;
  private position = 0;
  private previous = 0;
  private carry: number | null = null;

  constructor(inputRate: number, outputRate: number) {
    this.step = inputRate / outputRate;
  }

  push(bytes: Uint8Array): Uint8Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // An odd trailing byte waits for its partner in the next chunk.
    const firstByte = this.carry;
    const total = bytes.byteLength + (firstByte === null ? 0 : 1);
    const n = Math.floor(total / 2);
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const at = i * 2 - (firstByte === null ? 0 : 1);
      const lo = at < 0 ? (firstByte as number) : view.getUint8(at);
      const hi = view.getUint8(at + 1);
      x[i] = (hi << 24) >> 16 | lo;
    }
    this.carry = total % 2 === 1 ? view.getUint8(bytes.byteLength - 1) : null;
    if (n === 0) return new Uint8Array(0);
    const count = this.position <= n - 1 ? Math.floor((n - 1 - this.position) / this.step) + 1 : 0;
    const out = new Uint8Array(count * 2);
    const outView = new DataView(out.buffer);
    for (let k = 0; k < count; k++) {
      const pos = this.position + k * this.step;
      const i = Math.floor(pos);
      const frac = pos - i;
      const a = i < 0 ? this.previous : x[i];
      const value = frac === 0 ? a : a + (x[i + 1] - a) * frac;
      outView.setInt16(k * 2, Math.max(-32768, Math.min(32767, Math.round(value))), true);
    }
    this.position += count * this.step - n;
    this.previous = x[n - 1];
    return out;
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
