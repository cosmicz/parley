// Server-sent events fan-out from the phone to projector pages.
//
// The phone POSTs its state; every open /api/events stream receives it. The
// last state is replayed to a new subscriber so a reloaded projector page shows
// the current screen at once instead of waiting for the next utterance. Reset
// clears that replay.

import type { ServerResponse } from 'node:http';

export const HEARTBEAT_MS = 15_000;

export type HubEvent = 'state' | 'reset';

export class EventHub {
  private readonly subscribers = new Set<ServerResponse>();
  private lastState: unknown = undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private readonly heartbeatMs: number;

  constructor(heartbeatMs = HEARTBEAT_MS) {
    this.heartbeatMs = heartbeatMs;
  }

  get size(): number {
    return this.subscribers.size;
  }

  /** Turns res into an event stream; returns the unsubscribe function. */
  subscribe(res: ServerResponse): () => void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    if (this.lastState !== undefined) res.write(frame('state', this.lastState));
    this.subscribers.add(res);
    this.startHeartbeat();
    const unsubscribe = () => {
      this.subscribers.delete(res);
      if (this.subscribers.size === 0) this.stopHeartbeat();
    };
    res.on('close', unsubscribe);
    return unsubscribe;
  }

  publish(event: HubEvent, data: unknown): void {
    if (event === 'state') this.lastState = data;
    if (event === 'reset') this.lastState = undefined;
    const message = frame(event, data);
    for (const res of this.subscribers) res.write(message);
  }

  close(): void {
    for (const res of this.subscribers) res.end();
    this.subscribers.clear();
    this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const res of this.subscribers) res.write(': heartbeat\n\n');
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
}

// JSON.stringify never emits a raw newline, so one data line per event is safe.
export function frame(event: HubEvent, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
