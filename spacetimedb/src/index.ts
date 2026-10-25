import {
  schema,
  table,
  t,
  SenderError,
  type InferSchema,
  type ReducerCtx,
} from 'spacetimedb/server';

// ---------------------------------------------------------------------------
// Tables
//
// Only small, relational room state lives here. The map PNGs / raw grids stay
// in the static `data/` folder and are never stored in the database.
// ---------------------------------------------------------------------------

/** One row per room. `presenter*` mirrors the presenter's shared camera. */
const roomState = table(
  { name: 'room_state', public: true },
  {
    roomId: t.string().primaryKey(),
    manifestVersion: t.string(),
    presenter: t.option(t.identity()),
    viewRa: t.f64(),
    viewDec: t.f64(),
    viewZoom: t.f64(),
    viewYaw: t.f64(),
    viewPitch: t.f64(),
    activeLayer: t.u8(),
    spread: t.f64(),
    updatedAt: t.timestamp(),
  }
);

/** One row per connected participant. */
const presence = table(
  { name: 'presence', public: true },
  {
    identity: t.identity().primaryKey(),
    roomId: t.string().index('btree'),
    name: t.string(),
    color: t.string(),
    viewRa: t.f64(),
    viewDec: t.f64(),
    viewZoom: t.f64(),
    activeLayer: t.u8(),
    joinedAt: t.timestamp(),
    lastSeen: t.timestamp(),
  }
);

/** Sky-anchored flag/comment. Canonical coordinates are celestial (ra, dec, bin). */
const annotation = table(
  { name: 'annotation', public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    roomId: t.string().index('btree'),
    manifestVersion: t.string(),
    author: t.identity(),
    authorName: t.string(),
    authorColor: t.string(),
    ra: t.f64(),
    dec: t.f64(),
    bin: t.u8(),
    text: t.string(),
    createdAt: t.timestamp(),
  }
);

const spacetimedb = schema({ roomState, presence, annotation });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;

// ---------------------------------------------------------------------------
// Validation helpers (kept unexported: only reducers/hooks are module exports)
// ---------------------------------------------------------------------------

const ROOM_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_NAME = 32;
const MAX_TEXT = 280;
const MAX_ANNOTATIONS_PER_ROOM = 500;
const MAX_ANNOTATIONS_PER_USER = 50;
const MAX_LAYERS = 16;

function cleanRoom(roomId: string): string {
  const id = roomId.trim().toLowerCase();
  if (!ROOM_RE.test(id)) {
    throw new SenderError('Room id must be 1-32 chars: a-z, 0-9 and dashes');
  }
  return id;
}

function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (n.length < 1 || n.length > MAX_NAME) {
    throw new SenderError(`Name must be 1-${MAX_NAME} characters`);
  }
  return n;
}

function cleanColor(color: string): string {
  if (!COLOR_RE.test(color)) throw new SenderError('Color must be #rrggbb');
  return color.toLowerCase();
}

function finite(n: number, label: string): number {
  if (!Number.isFinite(n)) throw new SenderError(`${label} must be a finite number`);
  return n;
}

function cleanSky(ra: number, dec: number): { ra: number; dec: number } {
  finite(ra, 'ra');
  finite(dec, 'dec');
  if (dec < -90 || dec > 90) throw new SenderError('dec must be within [-90, 90]');
  if (ra < -360 || ra > 720) throw new SenderError('ra out of range');
  return { ra, dec };
}

function requirePresence(ctx: Ctx) {
  const me = ctx.db.presence.identity.find(ctx.sender);
  if (!me) throw new SenderError('Join a room first');
  return me;
}

/** Remove a participant, releasing the presenter role if they held it. */
function removeParticipant(ctx: Ctx) {
  const me = ctx.db.presence.identity.find(ctx.sender);
  if (!me) return;
  ctx.db.presence.identity.delete(ctx.sender);
  const room = ctx.db.roomState.roomId.find(me.roomId);
  if (!room) return;
  if (room.presenter && room.presenter.equals(ctx.sender)) {
    ctx.db.roomState.roomId.update({
      ...room,
      presenter: undefined,
      updatedAt: ctx.timestamp,
    });
  }
  // Garbage-collect rooms nobody is in and that hold no annotations. Rooms with
  // annotations are kept so flags stay bound to their manifest version.
  const hasPeople = ctx.db.presence.roomId.filter(me.roomId).next().done === false;
  const hasFlags = ctx.db.annotation.roomId.filter(me.roomId).next().done === false;
  if (!hasPeople && !hasFlags) ctx.db.roomState.roomId.delete(me.roomId);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const init = spacetimedb.init(_ctx => {
  // Nothing to seed: rooms are created lazily on first join.
});

export const onDisconnect = spacetimedb.clientDisconnected(ctx => {
  removeParticipant(ctx);
});

// ---------------------------------------------------------------------------
// Reducers
// ---------------------------------------------------------------------------

export const joinRoom = spacetimedb.reducer(
  {
    roomId: t.string(),
    name: t.string(),
    color: t.string(),
    manifestVersion: t.string(),
  },
  (ctx, args) => {
    const roomId = cleanRoom(args.roomId);
    const name = cleanName(args.name);
    const color = cleanColor(args.color);
    const manifestVersion = args.manifestVersion.trim();
    if (manifestVersion.length < 1 || manifestVersion.length > 128) {
      throw new SenderError('Invalid manifest version');
    }

    const existing = ctx.db.roomState.roomId.find(roomId);
    if (existing && existing.manifestVersion !== manifestVersion) {
      throw new SenderError(
        `Room "${roomId}" was created for a different map version; pick another room name`
      );
    }

    // Switching rooms (or re-joining) replaces the previous presence row.
    const prior = ctx.db.presence.identity.find(ctx.sender);
    if (prior && prior.roomId !== roomId) removeParticipant(ctx);

    if (!existing) {
      ctx.db.roomState.insert({
        roomId,
        manifestVersion,
        presenter: undefined,
        viewRa: 20,
        viewDec: -30,
        viewZoom: 1,
        viewYaw: 0,
        viewPitch: 0,
        activeLayer: 0,
        spread: 0.5,
        updatedAt: ctx.timestamp,
      });
    }

    const row = {
      identity: ctx.sender,
      roomId,
      name,
      color,
      viewRa: existing?.viewRa ?? 20,
      viewDec: existing?.viewDec ?? -30,
      viewZoom: existing?.viewZoom ?? 1,
      activeLayer: existing?.activeLayer ?? 0,
      joinedAt: ctx.timestamp,
      lastSeen: ctx.timestamp,
    };
    const current = ctx.db.presence.identity.find(ctx.sender);
    if (current) {
      ctx.db.presence.identity.update({
        ...current,
        roomId,
        name,
        color,
        lastSeen: ctx.timestamp,
      });
    } else {
      ctx.db.presence.insert(row);
    }
  }
);

export const leaveRoom = spacetimedb.reducer(ctx => {
  removeParticipant(ctx);
});

export const heartbeat = spacetimedb.reducer(ctx => {
  const me = requirePresence(ctx);
  ctx.db.presence.identity.update({ ...me, lastSeen: ctx.timestamp });
});

export const setProfile = spacetimedb.reducer(
  { name: t.string(), color: t.string() },
  (ctx, args) => {
    const me = requirePresence(ctx);
    const name = cleanName(args.name);
    const color = cleanColor(args.color);
    ctx.db.presence.identity.update({ ...me, name, color, lastSeen: ctx.timestamp });
    // Keep the author's existing flags visually consistent with their profile.
    for (const a of [...ctx.db.annotation.roomId.filter(me.roomId)]) {
      if (a.author.equals(ctx.sender)) {
        ctx.db.annotation.id.update({ ...a, authorName: name, authorColor: color });
      }
    }
  }
);

/**
 * Publish this user's camera/layer state. Always updates presence; also
 * updates the shared room view if the sender is the room's presenter.
 * Clients throttle calls so the DB only sees small, infrequent updates.
 */
export const updateView = spacetimedb.reducer(
  {
    ra: t.f64(),
    dec: t.f64(),
    zoom: t.f64(),
    yaw: t.f64(),
    pitch: t.f64(),
    activeLayer: t.u8(),
    spread: t.f64(),
  },
  (ctx, v) => {
    const me = requirePresence(ctx);
    const { ra, dec } = cleanSky(v.ra, v.dec);
    finite(v.zoom, 'zoom');
    finite(v.yaw, 'yaw');
    finite(v.pitch, 'pitch');
    finite(v.spread, 'spread');
    if (v.activeLayer >= MAX_LAYERS) throw new SenderError('Invalid layer');

    ctx.db.presence.identity.update({
      ...me,
      viewRa: ra,
      viewDec: dec,
      viewZoom: v.zoom,
      activeLayer: v.activeLayer,
      lastSeen: ctx.timestamp,
    });

    const room = ctx.db.roomState.roomId.find(me.roomId);
    if (room && room.presenter && room.presenter.equals(ctx.sender)) {
      ctx.db.roomState.roomId.update({
        ...room,
        viewRa: ra,
        viewDec: dec,
        viewZoom: v.zoom,
        viewYaw: v.yaw,
        viewPitch: v.pitch,
        activeLayer: v.activeLayer,
        spread: v.spread,
        updatedAt: ctx.timestamp,
      });
    }
  }
);

export const claimPresenter = spacetimedb.reducer(ctx => {
  const me = requirePresence(ctx);
  const room = ctx.db.roomState.roomId.find(me.roomId);
  if (!room) throw new SenderError('Room not found');
  if (room.presenter && !room.presenter.equals(ctx.sender)) {
    const other = ctx.db.presence.identity.find(room.presenter);
    if (other) throw new SenderError(`${other.name} is already presenting`);
  }
  ctx.db.roomState.roomId.update({
    ...room,
    presenter: ctx.sender,
    updatedAt: ctx.timestamp,
  });
});

export const releasePresenter = spacetimedb.reducer(ctx => {
  const me = requirePresence(ctx);
  const room = ctx.db.roomState.roomId.find(me.roomId);
  if (room && room.presenter && room.presenter.equals(ctx.sender)) {
    ctx.db.roomState.roomId.update({
      ...room,
      presenter: undefined,
      updatedAt: ctx.timestamp,
    });
  }
});

export const addAnnotation = spacetimedb.reducer(
  { ra: t.f64(), dec: t.f64(), bin: t.u8(), text: t.string() },
  (ctx, args) => {
    const me = requirePresence(ctx);
    const room = ctx.db.roomState.roomId.find(me.roomId);
    if (!room) throw new SenderError('Room not found');
    const { ra, dec } = cleanSky(args.ra, args.dec);
    if (args.bin >= MAX_LAYERS) throw new SenderError('Invalid layer');
    const text = args.text.trim();
    if (text.length < 1 || text.length > MAX_TEXT) {
      throw new SenderError(`Comment must be 1-${MAX_TEXT} characters`);
    }

    let roomCount = 0;
    let mine = 0;
    for (const a of ctx.db.annotation.roomId.filter(me.roomId)) {
      roomCount++;
      if (a.author.equals(ctx.sender)) mine++;
    }
    if (roomCount >= MAX_ANNOTATIONS_PER_ROOM) {
      throw new SenderError('This room has reached its annotation limit');
    }
    if (mine >= MAX_ANNOTATIONS_PER_USER) {
      throw new SenderError('You have reached your annotation limit; delete one first');
    }

    ctx.db.annotation.insert({
      id: 0n,
      roomId: me.roomId,
      manifestVersion: room.manifestVersion,
      author: ctx.sender,
      authorName: me.name,
      authorColor: me.color,
      ra,
      dec,
      bin: args.bin,
      text,
      createdAt: ctx.timestamp,
    });
  }
);

export const deleteAnnotation = spacetimedb.reducer(
  { id: t.u64() },
  (ctx, { id }) => {
    const a = ctx.db.annotation.id.find(id);
    if (!a) return;
    if (!a.author.equals(ctx.sender)) {
      throw new SenderError('You can only delete your own annotations');
    }
    ctx.db.annotation.id.delete(id);
    // A deleted last flag may leave an abandoned room behind.
    const hasPeople = ctx.db.presence.roomId.filter(a.roomId).next().done === false;
    const hasFlags = ctx.db.annotation.roomId.filter(a.roomId).next().done === false;
    if (!hasPeople && !hasFlags) ctx.db.roomState.roomId.delete(a.roomId);
  }
);
