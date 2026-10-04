// On-page stand-in for the G2 HUD when no Even app bridge is present: the
// same surface main.ts uses on Glasses, drawn as a 576x288 green-on-black box
// with the transcript above a bordered one-line suggestion, as on the glasses.
// The laptop microphone replaces the glasses microphone, and keys replace the
// temple gestures: Space or Enter asks for help, Escape is the double tap.

import { startBrowserMic } from './browser-mic.ts';
import type { GlassesHandlers } from './glasses.ts';

const GREEN = '#33ff66';
const FONT = '28px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export class DomHud {
  private readonly host: HTMLElement;
  private readonly transcript: HTMLDivElement;
  private readonly suggestion: HTMLDivElement;
  private handlers: GlassesHandlers | null = null;
  private mic: { stop(): void } | null = null;
  private readonly onKey = (event: KeyboardEvent) => this.handleKey(event);

  constructor(host: HTMLElement) {
    this.host = host;
    const box = element('div', {
      position: 'relative',
      width: '576px',
      height: '288px',
      background: '#000',
      color: GREEN,
      font: FONT,
      lineHeight: '1.45',
      overflow: 'hidden',
      boxSizing: 'border-box',
    });
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'Parley HUD preview');
    // Bottom-aligned so the newest words stay visible, as formatTranscript intends.
    this.transcript = element('div', {
      position: 'absolute',
      left: '0',
      top: '0',
      width: '576px',
      height: '216px',
      padding: '6px',
      boxSizing: 'border-box',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'flex-end',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
      overflow: 'hidden',
    });
    this.transcript.setAttribute('aria-live', 'polite');
    this.transcript.textContent = 'Parley: listening...';
    this.suggestion = element('div', {
      position: 'absolute',
      left: '0',
      top: '224px',
      width: '576px',
      height: '64px',
      padding: '6px',
      boxSizing: 'border-box',
      border: `1px solid ${GREEN}`,
      borderRadius: '4px',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'clip',
    });
    this.suggestion.setAttribute('aria-live', 'assertive');
    box.append(this.transcript, this.suggestion);
    this.host.replaceChildren(box);
  }

  async start(handlers: GlassesHandlers): Promise<void> {
    this.handlers = handlers;
    window.addEventListener('keydown', this.onKey);
    try {
      this.mic = await startBrowserMic(handlers.onPcm);
    } catch (err) {
      window.removeEventListener('keydown', this.onKey);
      this.handlers = null;
      throw err;
    }
  }

  setTranscript(text: string): void {
    this.transcript.textContent = text;
  }

  /** Resolves once the text is in the DOM, the counterpart of a dispatched HUD update. */
  async setSuggestion(text: string): Promise<void> {
    this.suggestion.textContent = text;
  }

  /** The glasses show a system exit dialog; confirming there raises a system exit. */
  async exitWithDialog(): Promise<void> {
    if (window.confirm('Exit Parley?')) this.handlers?.onExit();
  }

  async stop(): Promise<void> {
    window.removeEventListener('keydown', this.onKey);
    this.mic?.stop();
    this.mic = null;
    this.handlers = null;
  }

  private handleKey(event: KeyboardEvent): void {
    if (!this.handlers || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    // Leave keys alone while the operator types or operates a control.
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, button, [contenteditable]')) return;
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      this.handlers.onHelp();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.handlers.onDoubleTap();
    }
  }
}

function element(tag: 'div', style: Partial<CSSStyleDeclaration>): HTMLDivElement {
  const node = document.createElement(tag);
  Object.assign(node.style, style);
  return node;
}
