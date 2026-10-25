import { describe, expect, it } from 'vitest';
import { cleanRoomName } from './room';

describe('cleanRoomName', () => {
  it('lowercases, trims and dashes spaces', () => {
    expect(cleanRoomName('  Cal Hacks 26 ')).toBe('cal-hacks-26');
  });
  it('rejects empty, too long, or unsafe names', () => {
    expect(cleanRoomName('   ')).toBeNull();
    expect(cleanRoomName('a'.repeat(33))).toBeNull();
    expect(cleanRoomName('room!')).toBeNull();
    expect(cleanRoomName('-lead')).toBeNull();
    expect(cleanRoomName('a'.repeat(32))).toBe('a'.repeat(32));
  });
});
