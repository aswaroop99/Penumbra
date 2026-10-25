import type { Profile } from './client';

const PALETTE = ['#4cc9f0', '#f72585', '#ffd166', '#06d6a0', '#b388ff', '#ff9f68', '#9bf6ff', '#caffbf'];
const KEY = 'penumbra.profile';

/** The saved display name/colour, or a fresh random guest. Shared by every page of the app. */
export function initialProfile(): Profile {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<Profile>;
      if (typeof p.name === 'string' && p.name && typeof p.color === 'string' && /^#[0-9a-f]{6}$/i.test(p.color)) {
        return { name: p.name.slice(0, 32), color: p.color };
      }
    }
  } catch {
    /* ignore corrupt storage */
  }
  return {
    name: `Guest-${Math.floor(1000 + Math.random() * 9000)}`,
    color: PALETTE[Math.floor(Math.random() * PALETTE.length)],
  };
}

export function saveProfile(p: Profile): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
