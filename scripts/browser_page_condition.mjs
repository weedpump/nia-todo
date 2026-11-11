import { performance } from 'node:perf_hooks';

/** Poll an awaited browser predicate without treating its Promise as truthy. */
export async function waitForPageCondition(page, predicate, arg, { timeout = 30_000 } = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError('Browser condition timeout must be a positive finite number');
  }
  const deadline = performance.now() + timeout;
  const timeoutError = new Error(`Browser condition timed out after ${timeout}ms`);
  timeoutError.name = 'TimeoutError';
  let deadlineTimer;
  let pollTimer;
  const expired = new Promise((_, reject) => {
    deadlineTimer = setTimeout(() => reject(timeoutError), timeout);
  });
  try {
    while (performance.now() < deadline) {
      // One total deadline also bounds a predicate whose Promise never settles.
      // Do not overlap evaluations or retry rejected predicates.
      const value = await Promise.race([page.evaluate(predicate, arg), expired]);
      if (performance.now() >= deadline) throw timeoutError;
      if (value) return value;
      await Promise.race([
        new Promise(resolve => { pollTimer = setTimeout(resolve, Math.min(100, deadline - performance.now())); }),
        expired,
      ]);
    }
    throw timeoutError;
  } finally {
    clearTimeout(deadlineTimer);
    clearTimeout(pollTimer);
  }
}
