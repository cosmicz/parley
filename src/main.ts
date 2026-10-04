// Parley phone-side wiring (runs in the Even app's WebView or the simulator).
//
// Glasses microphone PCM goes two ways: to the pause detector, whose events
// drive the coach, and to the Soniox stream, whose transcript feeds the HUD and
// the coach. Coach effects become suggestion requests to our server, HUD
// updates, and state published to the projector page over the server's SSE
// relay. Keys never reach this page: speech-to-text uses a short-lived token
// from /api/stt-token, and the model is called server-side.
//
// Without an Even bridge (plain browser), the same loop runs on the laptop
// microphone with an on-page imitation of the HUD: the rehearsal path, and the
// stage fallback if Bluetooth fails.

import { Glasses } from './glasses.ts';
import { DomHud } from './dom-hud.ts';
import { PauseDetector, pcmBytesToInt16 } from './vad.ts';
import { Coach, type CoachEffect } from './coach.ts';
import { formatTranscript, formatSuggestion } from './hud-format.ts';
import type { SuggestResult } from './suggest-core.ts';
import { SonioxStream, type SttCallbacks } from './stt-soniox.ts';
import { SegmentStt } from './stt-segments.ts';

/** The surface main uses; Glasses (G2) and DomHud (laptop) both provide it. */
type Hud = Pick<Glasses, 'start' | 'setTranscript' | 'setSuggestion' | 'exitWithDialog' | 'stop'>;

interface Config {
  practiceLanguage: string;
  fallbackLanguage: string;
  model: string;
  /** soniox: streaming words; segments: one OpenRouter clip per utterance. */
  sttMode: 'soniox' | 'segments' | 'none';
}

/** The speech-to-text surface main uses; flush exists only in clip mode. */
interface Stt {
  start(): Promise<void>;
  sendPcm(bytes: Uint8Array): void;
  stop(): Promise<void>;
  flush?: () => Promise<void>;
}

const JSON_HEADERS = { 'content-type': 'application/json' };
const PUBLISH_INTERVAL_MS = 150;

const el = (id: string) => document.getElementById(id) as HTMLElement;

function log(message: string): void {
  console.log(`[parley] ${message}`);
  const line = document.createElement('div');
  line.textContent = `${new Date().toLocaleTimeString()} ${message}`;
  el('log').prepend(line);
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error ?? `${url} returned ${response.status}`);
  return body as T;
}

function waitForClick(button: HTMLElement): Promise<void> {
  button.hidden = false;
  return new Promise((resolve) => {
    button.addEventListener('click', () => {
      button.hidden = true;
      resolve();
    }, { once: true });
  });
}

async function main(): Promise<void> {
  const config = await getJson<Config>('/api/config');
  el('languages').textContent = `${config.practiceLanguage} practice, ${config.fallbackLanguage} fallback`;

  const glasses = await Glasses.connect();
  const hud: Hud = glasses ?? new DomHud(el('hud'));
  log(glasses ? 'Even bridge found: using the G2' : 'No Even bridge: laptop microphone and on-page HUD');
  // Browsers start audio only after a user gesture, so the laptop path waits
  // for a click before opening the microphone.
  if (!glasses) await waitForClick(el('start'));

  const segmented = config.sttMode === 'segments';
  if (config.sttMode === 'none') log('No speech-to-text key configured: set OPENAI_API_KEY or OPENROUTER_API_KEY (or SONIOX_API_KEY) in app/.env');
  log(`speech-to-text mode: ${config.sttMode}`);
  const coach = new Coach({ waitForTranscript: segmented });
  const vad = new PauseDetector();

  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  const publish = () => {
    el('transcript').textContent = coach.state.transcript;
    el('suggestion').textContent = coach.state.suggestion ?? '';
    el('phase').textContent = coach.state.phase;
    if (publishTimer) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      fetch('/api/state', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(coach.state) }).catch(() => {});
    }, PUBLISH_INTERVAL_MS);
  };

  const run = (effects: CoachEffect[]) => {
    for (const effect of effects) {
      if (effect.type === 'publish') publish();
      else if (effect.type === 'request') void suggest(effect.seq, effect.trigger, effect.transcript);
      else void showSuggestion(effect.seq, effect.text);
    }
  };

  async function suggest(seq: number, trigger: 'pause' | 'tap', transcript: string): Promise<void> {
    try {
      const body = await getJson<{ result: SuggestResult; modelMs: number }>('/api/suggest', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ transcript, trigger }),
      });
      log(`suggestion (${trigger}, model ${body.modelMs} ms): ${JSON.stringify(body.result)}`);
      run(coach.onSuggestion(seq, body.result));
    } catch (err) {
      log(`suggestion failed: ${String(err)}`);
      run(coach.onSuggestion(seq, { kind: 'invalid', reason: String(err) }));
    }
  }

  async function showSuggestion(seq: number | null, text: string): Promise<void> {
    await hud.setSuggestion(formatSuggestion(text || null));
    if (seq !== null) run(coach.onDispatched(seq, performance.now()));
  }

  const callbacks: SttCallbacks = {
    onTranscript: (text) => {
      run(coach.onTranscript(text));
      hud.setTranscript(formatTranscript(text));
    },
    onError: (err) => {
      log(`speech-to-text ${err.type}: ${err.message}`);
      hud.setTranscript(`[speech-to-text] ${err.message}`);
    },
    onState: (state) => log(`speech-to-text ${state}`),
  };
  const stt: Stt = segmented
    ? new SegmentStt(
        {
          transcribe: async (wav) => {
            const body = await getJson<{ text: string; sttMs: number }>('/api/transcribe', {
              method: 'POST',
              headers: { 'content-type': 'audio/wav' },
              body: new Blob([wav as BlobPart], { type: 'audio/wav' }),
            });
            log(`transcribed in ${body.sttMs} ms: ${body.text}`);
            return body.text;
          },
        },
        callbacks,
      )
    : new SonioxStream(
        {
          getTempKey: async () => (await getJson<{ apiKey: string }>('/api/stt-token')).apiKey,
          languageHints: [config.practiceLanguage, config.fallbackLanguage],
        },
        callbacks,
      );

  await hud.start({
    onPcm: (bytes) => {
      stt.sendPcm(bytes);
      for (const event of vad.push(pcmBytesToInt16(bytes))) {
        run(coach.onVad(event, performance.now()));
        // Clip mode: the pause closes the utterance; transcribe it now.
        if (event.kind === 'pause') void stt.flush?.();
      }
    },
    onHelp: () => {
      run(coach.onHelp(performance.now()));
      void stt.flush?.();
    },
    onDoubleTap: () => void hud.exitWithDialog(),
    onExit: () => {
      void stt.stop();
      void hud.stop();
    },
  });
  log('HUD ready, microphone open');

  try {
    await stt.start();
  } catch (err) {
    log(`speech-to-text did not start: ${String(err)}`);
    hud.setTranscript(`[speech-to-text] ${String(err)}`);
  }

  // The projector page's Reset button clears the session for a clean rerun.
  const events = new EventSource('/api/events');
  events.addEventListener('reset', () => {
    void (async () => {
      await stt.stop();
      vad.reset();
      run(coach.reset());
      hud.setTranscript(' ');
      await stt.start();
      log('session reset');
    })();
  });
}

main().catch((err) => log(`startup failed: ${String(err)}`));
