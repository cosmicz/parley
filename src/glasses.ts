// Thin wrapper over the Even Hub SDK bridge for Parley's two-container HUD.
//
// Layout: a transcript container (event capture, so temple gestures arrive
// here) above a bordered one-line suggestion container. Transcript updates are
// debounced (latest wins, unchanged text skipped) because every update crosses
// Bluetooth; suggestion updates go out immediately and resolve when dispatched,
// which is the endpoint of the app-side latency measurement.

import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  OsEventTypeList,
  AudioInputSource,
  StartUpPageCreateResult,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk';

export interface GlassesHandlers {
  onPcm(bytes: Uint8Array): void;
  /** Single tap or long press: the wearer asks for help now. */
  onHelp(): void;
  /** Double tap: leave the app (the SDK shows its exit dialog). */
  onDoubleTap(): void;
  /** System or abnormal exit: release the mic and the stream. */
  onExit(): void;
}

const TRANSCRIPT = { id: 1, name: 'transcript' };
const SUGGESTION = { id: 2, name: 'suggestion' };
const TRANSCRIPT_DEBOUNCE_MS = 120;

export class Glasses {
  private readonly bridge: EvenAppBridge;
  private unsubscribe: (() => void) | null = null;
  private transcriptTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTranscript: string | null = null;
  private sentTranscript = '';
  private sentSuggestion = '';

  private constructor(bridge: EvenAppBridge) {
    this.bridge = bridge;
  }

  /** Resolves to null outside the Even app or simulator (plain browser). */
  static async connect(timeoutMs = 6000): Promise<Glasses | null> {
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
    const bridge = await Promise.race([waitForEvenAppBridge(), timeout]);
    return bridge ? new Glasses(bridge) : null;
  }

  async start(handlers: GlassesHandlers): Promise<void> {
    const transcript = new TextContainerProperty({
      containerID: TRANSCRIPT.id,
      containerName: TRANSCRIPT.name,
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 216,
      borderWidth: 0,
      borderColor: 0,
      borderRadius: 0,
      paddingLength: 6,
      content: 'Parley: listening...',
      isEventCapture: 1,
    });
    const suggestion = new TextContainerProperty({
      containerID: SUGGESTION.id,
      containerName: SUGGESTION.name,
      xPosition: 0,
      yPosition: 224,
      width: 576,
      height: 64,
      borderWidth: 1,
      borderColor: 5,
      borderRadius: 4,
      paddingLength: 6,
      content: '',
      isEventCapture: 0,
    });
    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({ containerTotalNum: 2, textObject: [transcript, suggestion] }),
    );
    if (result !== StartUpPageCreateResult.success) {
      throw new Error(`HUD page creation failed (result ${result})`);
    }

    this.unsubscribe = this.bridge.onEvenHubEvent((event: EvenHubEvent) => {
      const pcm = event.audioEvent?.audioPcm;
      if (pcm) handlers.onPcm(pcm);
      const input = event.textEvent ?? event.sysEvent ?? event.listEvent;
      if (!input) return;
      // CLICK_EVENT is 0 and often arrives as undefined.
      const type = input.eventType ?? OsEventTypeList.CLICK_EVENT;
      switch (type) {
        case OsEventTypeList.CLICK_EVENT:
        case OsEventTypeList.LONG_PRESS_EVENT:
          handlers.onHelp();
          break;
        case OsEventTypeList.DOUBLE_CLICK_EVENT:
          handlers.onDoubleTap();
          break;
        case OsEventTypeList.SYSTEM_EXIT_EVENT:
        case OsEventTypeList.ABNORMAL_EXIT_EVENT:
          handlers.onExit();
          break;
        default:
          break;
      }
    });

    const micOpen = await this.bridge.audioControl(true, AudioInputSource.Glasses);
    if (!micOpen) throw new Error('Glasses microphone did not open');
  }

  setTranscript(text: string): void {
    this.pendingTranscript = text;
    if (this.transcriptTimer) return;
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = null;
      const next = this.pendingTranscript;
      this.pendingTranscript = null;
      if (next === null || next === this.sentTranscript) return;
      this.sentTranscript = next;
      void this.upgrade(TRANSCRIPT, next);
    }, TRANSCRIPT_DEBOUNCE_MS);
  }

  /** Sends immediately; resolves once the update has been dispatched. */
  async setSuggestion(text: string): Promise<void> {
    if (text === this.sentSuggestion) return;
    this.sentSuggestion = text;
    await this.upgrade(SUGGESTION, text);
  }

  async exitWithDialog(): Promise<void> {
    await this.bridge.shutDownPageContainer(1);
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.transcriptTimer) clearTimeout(this.transcriptTimer);
    this.transcriptTimer = null;
    await this.bridge.audioControl(false);
  }

  private async upgrade(target: { id: number; name: string }, content: string): Promise<boolean> {
    // An empty string may be ignored by the device; a single space clears the line.
    return this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID: target.id, containerName: target.name, content: content || ' ' }),
    );
  }
}
