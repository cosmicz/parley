// Hedged requests (pahax-k4s): live provider latency swung from under 1 s to
// over 10 s on 2026-10-04, so a slow answer from the preferred provider should
// not cost the turn. Start the preferred attempt at once; start the next one
// after `delayMs` without a success, or at once if every started attempt has
// failed. The first success wins and the others are aborted.

export const HEDGE_MS = 2_500;

export interface Attempt<T> {
  label: string;
  run: (signal: AbortSignal) => Promise<T>;
}

export function hedge<T>(attempts: Attempt<T>[], delayMs = HEDGE_MS): Promise<{ value: T; index: number }> {
  if (attempts.length === 0) return Promise.reject(new Error('no attempts'));
  const controllers = attempts.map(() => new AbortController());
  const failures: string[] = [];
  let started = 0;
  let failed = 0;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  return new Promise((resolve, reject) => {
    const startNext = () => {
      clearTimeout(timer);
      if (settled || started >= attempts.length) return;
      const index = started++;
      const attempt = attempts[index];
      attempt.run(controllers[index].signal).then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          controllers.forEach((controller, j) => {
            if (j !== index) controller.abort();
          });
          resolve({ value, index });
        },
        (err: unknown) => {
          if (settled) return;
          failures.push(`${attempt.label}: ${err instanceof Error ? err.message : String(err)}`);
          failed++;
          if (failed === attempts.length) {
            settled = true;
            reject(new Error(failures.join('; ')));
          } else if (failed === started) {
            startNext();
          }
        },
      );
      if (started < attempts.length) timer = setTimeout(startNext, delayMs);
    };
    startNext();
  });
}
