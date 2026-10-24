import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { throttle } from './throttle';

describe('throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => vi.useRealTimers());

  it('fires immediately, then collapses bursts into one trailing call with the latest args', () => {
    const fn = vi.fn();
    const t = throttle(fn, 100);
    t(1);
    t(2);
    t(3);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(1);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(3);
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honours a dynamic interval and can be cancelled', () => {
    const fn = vi.fn();
    let ms = 1000;
    const t = throttle(fn, () => ms);
    t('a');
    t('b');
    t.cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
    ms = 10;
    vi.advanceTimersByTime(20);
    t('c');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
