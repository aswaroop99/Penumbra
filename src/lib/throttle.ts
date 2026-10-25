/**
 * Leading + trailing throttle. The first call fires immediately; calls within
 * `interval` ms collapse into a single trailing call carrying the latest args.
 * `interval` may be a function so it can vary with state (e.g. presenter vs viewer).
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  interval: number | (() => number)
) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;
  const ms = () => (typeof interval === 'function' ? interval() : interval);

  const fire = (args: A) => {
    last = Date.now();
    pending = null;
    fn(...args);
  };

  const throttled = (...args: A) => {
    const wait = ms() - (Date.now() - last);
    if (wait <= 0 && !timer) {
      fire(args);
      return;
    }
    pending = args;
    if (!timer) {
      timer = setTimeout(
        () => {
          timer = null;
          if (pending) fire(pending);
        },
        Math.max(wait, 0)
      );
    }
  };

  throttled.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  return throttled;
}
