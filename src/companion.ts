import { parseCoachState, reduceCoachState, resetCoachState } from './companion-state.ts';

const transcript = document.querySelector<HTMLElement>('#transcript');
const suggestion = document.querySelector<HTMLElement>('#suggestion');
const phase = document.querySelector<HTMLElement>('#phase');
const connection = document.querySelector<HTMLElement>('#connection');
const latency = document.querySelector<HTMLElement>('#latency');
const resetButton = document.querySelector<HTMLButtonElement>('#reset');

if (!transcript || !suggestion || !phase || !connection || !latency || !resetButton) {
  throw new Error('Companion page is missing a required display element');
}

let state = resetCoachState();

function render(): void {
  transcript!.textContent = state.transcript || 'Waiting for speech…';
  transcript!.classList.toggle('empty', !state.transcript);
  suggestion!.textContent = state.suggestion || 'A French continuation will appear after a pause.';
  suggestion!.classList.toggle('empty', !state.suggestion);
  phase!.textContent = state.phase;
  latency!.textContent = state.pauseToHudDispatchMs === null
    ? 'Pause start (or tap) → HUD update sent, app-side: —'
    : `Pause start (or tap) → HUD update sent, app-side: ${Math.round(state.pauseToHudDispatchMs)} ms`;
}

function receive(event: MessageEvent): void {
  state = reduceCoachState(state, parseCoachState(event.data));
  render();
}

render();
const events = new EventSource('/api/events');
events.onmessage = receive;
events.addEventListener('state', (event) => receive(event as MessageEvent));
events.addEventListener('reset', () => {
  state = resetCoachState();
  render();
});
events.onopen = () => {
  connection.textContent = 'Connected';
  connection.dataset.state = 'connected';
};
events.onerror = () => {
  connection.textContent = 'Disconnected · reconnecting…';
  connection.dataset.state = 'disconnected';
};

// Reset clears the phone session and every projector page for a clean rerun.
resetButton.addEventListener('click', () => {
  fetch('/api/reset', { method: 'POST' }).catch(() => {
    connection.textContent = 'Reset failed · check the dev server';
  });
});
