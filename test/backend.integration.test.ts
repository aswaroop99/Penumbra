/**
 * Integration tests against a *running* local SpacetimeDB with the module published.
 *   npm run stdb:start      (terminal 1)
 *   npm run stdb:publish && npm run stdb:generate
 *   npm run test:backend    (terminal 2)
 *
 * Each test uses a unique room so runs never collide, and two independent
 * connections (= two browser tabs / two anonymous identities).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbConnection, tables } from '../src/generated';

const URI = process.env.VITE_SPACETIMEDB_URI ?? 'ws://localhost:3000';
const DB = process.env.VITE_SPACETIMEDB_DB ?? 'penumbra';
const V = 'test-map-v1';

interface Client {
  conn: DbConnection;
  hex: string;
  token: string;
}

const open: Client[] = [];

async function connect(token?: string): Promise<Client> {
  const client = await new Promise<Client>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`connect timeout to ${URI}/${DB}`)), 8000);
    DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withToken(token)
      .onConnect((conn, identity, tok) => {
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timer);
            resolve({ conn, hex: identity.toHexString(), token: tok });
          })
          .onError(() => reject(new Error('subscription failed')))
          .subscribe([tables.roomState, tables.presence, tables.annotation]);
      })
      .onConnectError((_c, e) => reject(e))
      .build();
  });
  open.push(client);
  return client;
}

async function waitFor<T>(fn: () => T | undefined | null | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

let n = 0;
const room = () => `t-${Date.now().toString(36)}-${n++}`;
const rows = <T>(it: Iterable<T>) => [...it];

const join = (c: Client, roomId: string, name = 'Ada', color = '#33aaff', version = V) =>
  c.conn.reducers.joinRoom({ roomId, name, color, manifestVersion: version });

const view = (ra = 10, dec = -20, layer = 1) => ({
  ra,
  dec,
  zoom: 9,
  yaw: 0.1,
  pitch: -0.2,
  activeLayer: layer,
  spread: 0.7,
});

afterAll(async () => {
  for (const c of open) c.conn.disconnect();
  // give the server a moment to run its disconnect handlers (presence + empty-room cleanup)
  await new Promise((r) => setTimeout(r, 500));
});

describe('backend: rooms & presence', () => {
  let a: Client;
  let b: Client;
  beforeAll(async () => {
    [a, b] = await Promise.all([connect(), connect()]);
  });

  it('gives each connection its own identity', () => {
    expect(a.hex).not.toBe(b.hex);
  });

  it('creates a room lazily and shows presence to other clients live', async () => {
    const r = room();
    await join(a, r, 'Ada', '#33AAFF');
    await join(b, r, 'Bo', '#ff8800');
    await waitFor(() => rows(b.conn.db.presence.iter()).filter((p) => p.roomId === r).length === 2);
    const state = rows(a.conn.db.roomState.iter()).find((s) => s.roomId === r)!;
    expect(state.manifestVersion).toBe(V);
    expect(state.presenter).toBeUndefined();
    const ada = rows(b.conn.db.presence.iter()).find((p) => p.identity.toHexString() === a.hex)!;
    expect(ada.name).toBe('Ada');
    expect(ada.color).toBe('#33aaff'); // normalised to lowercase
  });

  it('rejects join with a different manifest version', async () => {
    const r = room();
    await join(a, r);
    await expect(join(b, r, 'Bo', '#ff8800', 'other-version')).rejects.toThrow(/different map version/);
  });

  it('validates room id, name and colour', async () => {
    await expect(join(a, 'Bad Room!')).rejects.toThrow(/Room id/);
    await expect(join(a, room(), '   ')).rejects.toThrow(/Name/);
    await expect(join(a, room(), 'x'.repeat(33))).rejects.toThrow(/Name/);
    await expect(join(a, room(), 'Ada', 'red')).rejects.toThrow(/Color/);
  });

  it('requires joining before any room action', async () => {
    const c = await connect();
    await expect(c.conn.reducers.heartbeat({})).rejects.toThrow(/Join a room first/);
    await expect(c.conn.reducers.updateView(view())).rejects.toThrow(/Join a room first/);
    await expect(
      c.conn.reducers.addAnnotation({ ra: 1, dec: 1, bin: 0, text: 'hi' })
    ).rejects.toThrow(/Join a room first/);
  });

  it('updates profile (and the author label on existing flags)', async () => {
    const r = room();
    await join(a, r, 'Ada', '#33aaff');
    await a.conn.reducers.addAnnotation({ ra: 5, dec: -5, bin: 0, text: 'mine' });
    await a.conn.reducers.setProfile({ name: 'Ada L', color: '#112233' });
    await waitFor(() =>
      rows(b.conn.db.annotation.iter()).find((x) => x.roomId === r && x.authorName === 'Ada L')
    );
    const flag = rows(a.conn.db.annotation.iter()).find((x) => x.roomId === r)!;
    expect(flag.authorColor).toBe('#112233');
    await a.conn.reducers.deleteAnnotation({ id: flag.id });
  });

  it('removes presence on disconnect and when switching rooms', async () => {
    const c = await connect();
    const r1 = room();
    const r2 = room();
    await join(c, r1);
    await waitFor(() => rows(a.conn.db.presence.iter()).some((p) => p.identity.toHexString() === c.hex));
    await join(c, r2);
    await waitFor(() => {
      const mine = rows(a.conn.db.presence.iter()).filter((p) => p.identity.toHexString() === c.hex);
      return mine.length === 1 && mine[0].roomId === r2;
    });
    c.conn.disconnect();
    await waitFor(() => !rows(a.conn.db.presence.iter()).some((p) => p.identity.toHexString() === c.hex));
    // both rooms were left empty with no flags → garbage-collected
    await waitFor(() => !rows(a.conn.db.roomState.iter()).some((s) => s.roomId === r1 || s.roomId === r2));
  });

  it('keeps an empty room that still has annotations', async () => {
    const c = await connect();
    const r = room();
    await join(c, r);
    await c.conn.reducers.addAnnotation({ ra: 3, dec: -3, bin: 0, text: 'keep me' });
    await waitFor(() => rows(a.conn.db.annotation.iter()).some((x) => x.roomId === r));
    c.conn.disconnect();
    await waitFor(() => !rows(a.conn.db.presence.iter()).some((p) => p.roomId === r));
    await new Promise((res) => setTimeout(res, 200));
    expect(rows(a.conn.db.roomState.iter()).some((s) => s.roomId === r)).toBe(true);

    // the same anonymous identity (same token) can still delete its flag afterwards
    const again = await connect(c.token);
    expect(again.hex).toBe(c.hex);
    const flag = rows(again.conn.db.annotation.iter()).find((x) => x.roomId === r)!;
    await again.conn.reducers.deleteAnnotation({ id: flag.id });
  });
});

describe('backend: shared view & presenter', () => {
  let a: Client;
  let b: Client;
  let r: string;
  beforeAll(async () => {
    [a, b] = await Promise.all([connect(), connect()]);
    r = room();
    await join(a, r, 'Ada');
    await join(b, r, 'Bo', '#ff8800');
  });
  const state = (c: Client) => rows(c.conn.db.roomState.iter()).find((s) => s.roomId === r)!;

  it('only updates the shared room view for the presenter; presence always updates', async () => {
    await b.conn.reducers.updateView(view(50, -40, 2)); // not presenter
    await waitFor(() =>
      rows(a.conn.db.presence.iter()).find((p) => p.identity.toHexString() === b.hex && p.activeLayer === 2)
    );
    expect(state(a).viewRa).toBe(20); // untouched default

    await a.conn.reducers.claimPresenter({});
    await waitFor(() => state(b).presenter?.toHexString() === a.hex);
    await a.conn.reducers.updateView(view(77, -33, 3));
    await waitFor(() => state(b).viewRa === 77);
    const s = state(b);
    expect([s.viewDec, s.activeLayer, s.spread, s.viewZoom, s.viewYaw, s.viewPitch]).toEqual([
      -33, 3, 0.7, 9, 0.1, -0.2,
    ]);
  });

  it('rejects a second presenter, then hands over after release', async () => {
    await expect(b.conn.reducers.claimPresenter({})).rejects.toThrow(/already presenting/);
    await b.conn.reducers.releasePresenter({}); // no-op for non-presenter
    expect(state(b).presenter?.toHexString()).toBe(a.hex);
    await a.conn.reducers.releasePresenter({});
    await waitFor(() => state(b).presenter === undefined);
    await b.conn.reducers.claimPresenter({});
    await waitFor(() => state(a).presenter?.toHexString() === b.hex);
  });

  it('frees the presenter slot when the presenter disconnects', async () => {
    await waitFor(() => state(a).presenter?.toHexString() === b.hex);
    b.conn.disconnect();
    await waitFor(() => state(a).presenter === undefined);
  });

  it('validates view numbers and layer index', async () => {
    await expect(a.conn.reducers.updateView({ ...view(), dec: 95 })).rejects.toThrow(/dec/);
    await expect(a.conn.reducers.updateView({ ...view(), ra: NaN })).rejects.toThrow(/finite/);
    await expect(a.conn.reducers.updateView({ ...view(), activeLayer: 40 })).rejects.toThrow(/layer/i);
  });
});

describe('backend: annotations', () => {
  let a: Client;
  let b: Client;
  let r: string;
  beforeAll(async () => {
    [a, b] = await Promise.all([connect(), connect()]);
    r = room();
    await join(a, r, 'Ada', '#33aaff');
    await join(b, r, 'Bo', '#ff8800');
  });
  const inRoom = (c: Client) => rows(c.conn.db.annotation.iter()).filter((x) => x.roomId === r);

  it('syncs sky-anchored annotations to everyone in the room, stamped with the map version', async () => {
    await a.conn.reducers.addAnnotation({ ra: 316.05, dec: -29.22, bin: 2, text: '  big cluster  ' });
    const got = await waitFor(() => inRoom(b)[0]);
    expect(got).toMatchObject({
      ra: 316.05,
      dec: -29.22,
      bin: 2,
      text: 'big cluster',
      authorName: 'Ada',
      authorColor: '#33aaff',
      manifestVersion: V,
    });
    expect(got.author.toHexString()).toBe(a.hex);
  });

  it('does not leak annotations across rooms', async () => {
    const other = room();
    const c = await connect();
    await join(c, other, 'Cy');
    await c.conn.reducers.addAnnotation({ ra: 1, dec: 1, bin: 0, text: 'elsewhere' });
    await waitFor(() => rows(a.conn.db.annotation.iter()).some((x) => x.roomId === other));
    expect(inRoom(a).every((x) => x.text !== 'elsewhere')).toBe(true);
    const stray = rows(c.conn.db.annotation.iter()).find((x) => x.roomId === other)!;
    await c.conn.reducers.deleteAnnotation({ id: stray.id });
  });

  it('only lets the author delete', async () => {
    const id = inRoom(a)[0].id;
    await expect(b.conn.reducers.deleteAnnotation({ id })).rejects.toThrow(/only delete your own/);
    expect(inRoom(a)).toHaveLength(1);
    await a.conn.reducers.deleteAnnotation({ id });
    await waitFor(() => inRoom(b).length === 0);
    await a.conn.reducers.deleteAnnotation({ id }); // idempotent
  });

  it('validates coordinates, layer and text', async () => {
    const ok = { ra: 10, dec: -10, bin: 0, text: 'x' };
    await expect(a.conn.reducers.addAnnotation({ ...ok, dec: -91 })).rejects.toThrow(/dec/);
    await expect(a.conn.reducers.addAnnotation({ ...ok, ra: 9999 })).rejects.toThrow(/ra/);
    await expect(a.conn.reducers.addAnnotation({ ...ok, bin: 99 })).rejects.toThrow(/layer/i);
    await expect(a.conn.reducers.addAnnotation({ ...ok, text: '   ' })).rejects.toThrow(/Comment/);
    await expect(a.conn.reducers.addAnnotation({ ...ok, text: 'y'.repeat(281) })).rejects.toThrow(/Comment/);
    expect(inRoom(a)).toHaveLength(0);
  });

  it('caps annotations per user', async () => {
    for (let i = 0; i < 50; i++) {
      await a.conn.reducers.addAnnotation({ ra: i, dec: -i / 2, bin: 0, text: `f${i}` });
    }
    await expect(
      a.conn.reducers.addAnnotation({ ra: 1, dec: 1, bin: 0, text: 'one too many' })
    ).rejects.toThrow(/limit/);
    await b.conn.reducers.addAnnotation({ ra: 2, dec: 2, bin: 0, text: 'bo is fine' }); // per-user cap
    // clean up so the shared DB does not accumulate test data
    for (const x of inRoom(a)) {
      if (x.author.toHexString() === a.hex) await a.conn.reducers.deleteAnnotation({ id: x.id });
    }
    for (const x of inRoom(b)) {
      if (x.author.toHexString() === b.hex) await b.conn.reducers.deleteAnnotation({ id: x.id });
    }
  }, 30_000);
});
