import { TranscriptAssembler } from './transcript.ts';

const SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const DEFAULT_KEEPALIVE_MS = 10_000;

export interface SttOptions {
  /** Must fetch a short-lived single-use key from the app server. */
  getTempKey: () => Promise<string>;
  languageHints: string[];
  model?: string;
  /** Shorter interval is useful for deterministic local transport tests. */
  keepaliveMs?: number;
  /** Time to await the final server response after sending end-of-audio. */
  stopTimeoutMs?: number;
}

export interface SttCallbacks {
  onTranscript(text: string): void;
  onError(err: { type: string; message: string }): void;
  onState(state: 'connecting' | 'open' | 'closed'): void;
}

export class SonioxStream {
  private socket: WebSocket | null = null;
  private readonly transcript = new TranscriptAssembler();
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSentAt = 0;
  private pendingStop: (() => void) | null = null;
  private pendingStart: ((error: Error) => void) | null = null;
  private stopPromise: Promise<void> | null = null;
  private generation = 0;
  private started = false;
  private closed = true;
  private finishing = false;
  private readonly opts: SttOptions;
  private readonly cb: SttCallbacks;
  private readonly WebSocketCtor: typeof WebSocket;

  constructor(
    opts: SttOptions,
    cb: SttCallbacks,
    WebSocketCtor: typeof WebSocket = WebSocket,
  ) {
    this.opts = opts;
    this.cb = cb;
    this.WebSocketCtor = WebSocketCtor;
  }

  async start(): Promise<void> {
    if (this.started && !this.closed) throw new Error('Soniox stream already started');
    this.started = true;
    this.closed = false;
    this.finishing = false;
    this.stopPromise = null;
    const generation = ++this.generation;
    this.transcript.reset();
    this.cb.onState('connecting');

    let key: string;
    try {
      key = await this.opts.getTempKey();
      if (!key) throw new Error('Temporary Soniox key was empty');
    } catch (error) {
      if (generation === this.generation) this.fail('temporary_key', error);
      throw error;
    }
    if (generation !== this.generation || this.closed) {
      throw new Error('Soniox stream stopped before opening');
    }

    return new Promise<void>((resolve, reject) => {
      this.pendingStart = reject;
      const socket = new this.WebSocketCtor(SONIOX_URL);
      this.socket = socket;
      socket.addEventListener('open', () => {
        if (this.socket !== socket || this.closed) return;
        this.pendingStart = null;
        socket.send(JSON.stringify({
          api_key: key,
          model: this.opts.model ?? 'stt-rt-v5',
          audio_format: 'pcm_s16le',
          sample_rate: 16_000,
          num_channels: 1,
          language_hints: this.opts.languageHints,
          enable_language_identification: true,
          enable_endpoint_detection: true,
        }));
        this.lastSentAt = Date.now();
        this.keepalive = setInterval(() => {
          if (!this.finishing && socket.readyState === 1 &&
              Date.now() - this.lastSentAt >= (this.opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS)) {
            socket.send('{"type":"keepalive"}');
            this.lastSentAt = Date.now();
          }
        }, this.opts.keepaliveMs ?? DEFAULT_KEEPALIVE_MS);
        this.cb.onState('open');
        resolve();
      });
      socket.addEventListener('message', event => {
        if (this.socket === socket && !this.closed) this.handleMessage(event.data);
      });
      socket.addEventListener('error', () => {
        if (this.socket !== socket || this.closed) return;
        this.fail('transport_error', new Error('Soniox WebSocket transport error'));
      });
      socket.addEventListener('close', () => {
        if (this.socket !== socket || this.closed) return;
        this.markClosed(new Error('Soniox WebSocket closed before opening'));
      });
    });
  }

  sendPcm(bytes: Uint8Array): void {
    // The G2 mic can deliver frames while the temporary key or socket opens.
    // Dropping these early frames keeps the live loop nonblocking.
    if (!this.socket || this.socket.readyState !== 1) return;
    if (this.finishing) return;
    if (bytes.byteLength === 0) return;
    // Copy: callers may reuse the microphone buffer before WebSocket transmits it.
    this.socket.send(bytes.slice());
    this.lastSentAt = Date.now();
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    if (this.closed) return;
    if (!socket) {
      ++this.generation;
      this.markClosed();
      return;
    }
    if (this.finishing) return this.stopPromise ?? Promise.resolve();
    this.finishing = true;
    this.clearKeepalive();
    if (socket.readyState !== 1) {
      socket.close();
      this.markClosed(new Error('Soniox stream stopped before opening'));
      return;
    }
    // Soniox sends remaining finals and `finished: true` after an empty frame.
    this.stopPromise = new Promise(resolve => { this.pendingStop = resolve; });
    const timeoutMs = this.opts.stopTimeoutMs ?? 2_000;
    this.stopTimer = setTimeout(() => {
      if (this.socket !== socket || this.closed) return;
      this.cb.onError({ type: 'finish_timeout', message: `Soniox did not finish within ${timeoutMs} ms` });
      socket.close();
      this.markClosed();
    }, timeoutMs);
    socket.send(new Uint8Array());
    return this.stopPromise;
  }

  private handleMessage(raw: unknown): void {
    let msg: { tokens?: { text: string; is_final: boolean }[]; finished?: boolean; error_type?: string; error_message?: string };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      this.cb.onError({ type: 'invalid_response', message: 'Soniox returned invalid JSON' });
      return;
    }
    if (msg.error_type) {
      this.cb.onError({ type: msg.error_type, message: msg.error_message ?? msg.error_type });
      return;
    }
    if (msg.tokens?.length) this.cb.onTranscript(this.transcript.apply(msg));
    if (msg.finished) {
      this.socket?.close();
      this.markClosed();
    }
  }

  private fail(type: string, error: unknown): void {
    this.cb.onError({ type, message: error instanceof Error ? error.message : String(error) });
    this.markClosed(error instanceof Error ? error : new Error(String(error)));
  }

  private markClosed(startError = new Error('Soniox stream stopped before opening')): void {
    if (this.closed) return;
    this.closed = true;
    this.clearKeepalive();
    if (this.stopTimer !== null) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.pendingStart?.(startError);
    this.pendingStart = null;
    this.cb.onState('closed');
    this.pendingStop?.();
    this.pendingStop = null;
    this.stopPromise = null;
  }

  private clearKeepalive(): void {
    if (this.keepalive !== null) clearInterval(this.keepalive);
    this.keepalive = null;
  }
}
