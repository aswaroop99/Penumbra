const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Normalise a user-typed room name; null if it is not a valid room id. */
export function cleanRoomName(s: string): string | null {
  const r = s.trim().toLowerCase().replace(/\s+/g, '-');
  return ROOM_RE.test(r) ? r : null;
}
