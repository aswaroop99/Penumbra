import { DbConnection, tables, type SubscriptionHandle } from '../generated';
import type { Annotation, Presence, RoomState } from '../generated/types';

/**
 * Framework-free SpacetimeDB client. This is the whole "backend" surface the
 * viewer talks to: connect, join a room, publish the camera, claim/release the
 * presenter role, and add/delete flags. UI code subscribes via `onChange`.
 */

export const STDB_URI: string = import.meta.env.VITE_SPACETIMEDB_URI ?? 'ws://localhost:3000';
export const STDB_DB: string = import.meta.env.VITE_SPACETIMEDB_DB ?? 'penumbra';
export const DEFAULT_ROOM: string = import.meta.env.VITE_DEFAULT_ROOM ?? 'penumbra-demo';

export interface Profile {
  name: string;
  color: string;
}

export interface SharedView {
  ra: number;
  dec: number;
  zoom: number;
  yaw: number;
  pitch: number;
  activeLayer: number;
  spread: number;
}

export type ConnStatus = 'connecting' | 'connected' | 'error';

export interface CollabState {
  status: ConnStatus;
  /** Last failed action (join / annotate / presenter ...), human readable. */
  actionError: string | null;
  identityHex: string | null;
  joined: boolean;
  room: RoomState | null;
  participants: Presence[];
  annotations: Annotation[];
  me: Presence | null;
  presenter: Presence | null;
  isPresenter: boolean;
}

const HEARTBEAT_MS = 10_000;

/**
 * Anonymous identity tokens are kept per *tab* (sessionStorage), so two tabs are
 * two independent participants, and a reload keeps the same identity (and your
 * ability to delete your own flags). No account or API key is involved.
 */
const TOKEN_KEY = `penumbra.token.${STDB_DB}`;

function readToken(): string | undefined {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeToken(token: string | null) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: fall back to a fresh identity each load */
  }
}

function msg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Reducer errors arrive as "... Error: <message>"; keep the readable tail.
  return raw.replace(/^.*?SenderError:\s*/i, '').replace(/^Error:\s*/i, '');
}

const micros = (t: { microsSinceUnixEpoch: bigint }) => t.microsSinceUnixEpoch;

export class Collab {
  private conn: DbConnection | null = null;
  private identityHex: string | null = null;
  private status: ConnStatus = 'connecting';
  private actionError: string | null = null;
  private roomId: string | null = null;
  private profile: Profile;
  private manifestVersion: string;
  private subs: SubscriptionHandle[] = [];
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(s: CollabState) => void>();
  private scheduled = false;
  private state: CollabState = emptyState();

  constructor(profile: Profile, manifestVersion: string) {
    this.profile = profile;
    this.manifestVersion = manifestVersion;
  }

  onChange(cb: (s: CollabState) => void): () => void {
    this.listeners.add(cb);
    cb(this.state);
    return () => this.listeners.delete(cb);
  }

  get snapshot(): CollabState {
    return this.state;
  }

  connect() {
    DbConnection.builder()
      .withUri(STDB_URI)
      .withDatabaseName(STDB_DB)
      .withToken(readToken())
      .withAutomaticReconnect()
      .onConnect((conn, identity, token) => {
        writeToken(token);
        this.conn = conn;
        this.identityHex = identity.toHexString();
        this.status = 'connected';
        this.attach(conn);
        this.resubscribe();
        void this.join();
        this.startHeartbeat();
        this.notify();
      })
      .onAutomaticReconnect((conn) => {
        // The server dropped our presence row when the old socket closed.
        this.conn = conn;
        this.status = 'connected';
        void this.join();
        this.notify();
      })
      .onConnectError(() => {
        // A stale token (e.g. after the database was recreated) must not wedge reconnects.
        writeToken(null);
        this.status = 'error';
        this.notify();
      })
      .onDisconnect((_ctx, _err, nextAttempt) => {
        this.status = nextAttempt !== undefined ? 'connecting' : 'error';
        this.notify();
      })
      .build();
  }

  // -- room lifecycle -------------------------------------------------------

  /** Join (or switch to) `roomId`. Safe to call before the connection is up. */
  setRoom(roomId: string) {
    if (roomId === this.roomId) return;
    const prev = this.roomId;
    this.roomId = roomId;
    this.actionError = null;
    if (!this.conn) return;
    if (prev) void this.conn.reducers.leaveRoom({}).catch(() => {});
    this.resubscribe();
    void this.join();
    this.notify();
  }

  clearActionError() {
    this.actionError = null;
    this.notify();
  }

  private async join() {
    const conn = this.conn;
    if (!conn || !this.roomId) return;
    try {
      await conn.reducers.joinRoom({
        roomId: this.roomId,
        name: this.profile.name,
        color: this.profile.color,
        manifestVersion: this.manifestVersion,
      });
      this.actionError = null;
    } catch (e) {
      this.actionError = msg(e);
    }
    this.notify();
  }

  private startHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    // If the server forgot us (e.g. after a reconnect), rejoin.
    this.heartbeat = setInterval(() => {
      this.conn?.reducers.heartbeat({}).catch((e: unknown) => {
        if (/join a room first/i.test(msg(e))) void this.join();
      });
    }, HEARTBEAT_MS);
  }

  private resubscribe() {
    const conn = this.conn;
    if (!conn) return;
    for (const s of this.subs) {
      try {
        s.unsubscribe();
      } catch {
        /* already ended */
      }
    }
    this.subs = [];
    if (!this.roomId) return;
    const rid = this.roomId;
    const onError = () => {
      this.actionError = 'Subscription failed; check the SpacetimeDB module is published.';
      this.notify();
    };
    this.subs = [
      conn.subscriptionBuilder().onApplied(() => this.notify()).onError(onError)
        .subscribe(tables.roomState.where((r) => r.roomId.eq(rid))),
      conn.subscriptionBuilder().onApplied(() => this.notify()).onError(onError)
        .subscribe(tables.presence.where((r) => r.roomId.eq(rid))),
      conn.subscriptionBuilder().onApplied(() => this.notify()).onError(onError)
        .subscribe(tables.annotation.where((r) => r.roomId.eq(rid))),
    ];
  }

  private attach(conn: DbConnection) {
    const poke = () => this.notify();
    for (const t of [conn.db.roomState, conn.db.presence, conn.db.annotation]) {
      t.onInsert(poke);
      t.onUpdate(poke);
      t.onDelete(poke);
    }
  }

  // -- actions --------------------------------------------------------------

  setProfile(p: Profile) {
    this.profile = p;
    if (!this.conn || !this.state.me) return;
    this.run(() => this.conn!.reducers.setProfile({ name: p.name, color: p.color }));
  }

  publishView(v: SharedView) {
    if (!this.conn || !this.state.me) return;
    this.conn.reducers.updateView(v).catch(() => {
      /* view updates are best-effort; the next one supersedes this */
    });
  }

  claimPresenter() {
    if (this.conn) this.run(() => this.conn!.reducers.claimPresenter({}));
  }

  releasePresenter() {
    if (this.conn) this.run(() => this.conn!.reducers.releasePresenter({}));
  }

  async addAnnotation(a: { ra: number; dec: number; bin: number; text: string }): Promise<boolean> {
    if (!this.conn) return false;
    try {
      await this.conn.reducers.addAnnotation(a);
      return true;
    } catch (e) {
      this.actionError = msg(e);
      this.notify();
      return false;
    }
  }

  deleteAnnotation(id: bigint) {
    if (this.conn) this.run(() => this.conn!.reducers.deleteAnnotation({ id }));
  }

  private run(fn: () => Promise<void> | undefined) {
    Promise.resolve(fn()).catch((e: unknown) => {
      this.actionError = msg(e);
      this.notify();
    });
  }

  // -- derived state --------------------------------------------------------

  private notify() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.state = this.compute();
      for (const cb of this.listeners) cb(this.state);
    });
  }

  private compute(): CollabState {
    const conn = this.conn;
    const rid = this.roomId;
    const idHex = this.identityHex;
    if (!conn || !rid) {
      return { ...emptyState(), status: this.status, actionError: this.actionError, identityHex: idHex };
    }
    const participants = [...conn.db.presence.iter()]
      .filter((p) => p.roomId === rid)
      .sort((a, b) => Number(micros(a.joinedAt) - micros(b.joinedAt)));
    const annotations = [...conn.db.annotation.iter()]
      .filter((a) => a.roomId === rid)
      .sort((a, b) => Number(micros(a.createdAt) - micros(b.createdAt)));
    const room = [...conn.db.roomState.iter()].find((r) => r.roomId === rid) ?? null;
    const me = participants.find((p) => p.identity.toHexString() === idHex) ?? null;
    const presenterHex = room?.presenter?.toHexString() ?? null;
    const presenter = presenterHex
      ? (participants.find((p) => p.identity.toHexString() === presenterHex) ?? null)
      : null;
    return {
      status: this.status,
      actionError: this.actionError,
      identityHex: idHex,
      joined: me !== null,
      room,
      participants,
      annotations,
      me,
      presenter,
      isPresenter: presenterHex !== null && presenterHex === idHex,
    };
  }
}

function emptyState(): CollabState {
  return {
    status: 'connecting',
    actionError: null,
    identityHex: null,
    joined: false,
    room: null,
    participants: [],
    annotations: [],
    me: null,
    presenter: null,
    isPresenter: false,
  };
}
