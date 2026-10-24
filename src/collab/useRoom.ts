import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables, type DbConnection } from '../generated';
import type { Annotation, Presence, RoomState } from '../generated/types';

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

export interface RoomApi {
  status: ConnStatus;
  connectionError: string | null;
  /** Last failed action (join / annotate / presenter ...), human readable. */
  actionError: string | null;
  clearActionError: () => void;
  identityHex: string | null;
  joined: boolean;
  room: RoomState | null;
  participants: Presence[];
  annotations: Annotation[];
  me: Presence | null;
  presenter: Presence | null;
  isPresenter: boolean;
  setProfile: (p: Profile) => void;
  publishView: (v: SharedView) => void;
  claimPresenter: () => void;
  releasePresenter: () => void;
  addAnnotation: (a: { ra: number; dec: number; bin: number; text: string }) => Promise<boolean>;
  deleteAnnotation: (id: bigint) => void;
}

const HEARTBEAT_MS = 10_000;

function msg(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Reducer errors arrive as "... Error: <message>"; keep the readable tail.
  return raw.replace(/^.*?SenderError:\s*/i, '').replace(/^Error:\s*/i, '');
}

/**
 * Joins `roomId` (when non-null) and exposes live room state, presence and
 * annotations. Everything the UI needs from SpacetimeDB goes through here.
 */
export function useRoom(roomId: string | null, profile: Profile, manifestVersion: string): RoomApi {
  const state = useSpacetimeDB();
  const conn = state.getConnection() as DbConnection | null;
  const active = state.isActive && conn !== null;
  const connectionKey = state.connectionId.toHexString();
  const enabled = active && roomId !== null;
  const rid = roomId ?? '';

  const [roomRows] = useTable(tables.roomState.where((r) => r.roomId.eq(rid)), { enabled });
  const [presenceRows] = useTable(tables.presence.where((r) => r.roomId.eq(rid)), { enabled });
  const [annotationRows] = useTable(tables.annotation.where((r) => r.roomId.eq(rid)), { enabled });

  const [actionError, setActionError] = useState<string | null>(null);
  const clearActionError = useCallback(() => setActionError(null), []);

  const profileRef = useRef(profile);
  profileRef.current = profile;

  const identityHex = state.identity?.toHexString() ?? null;

  const join = useCallback(async () => {
    if (!conn || !roomId) return;
    try {
      await conn.reducers.joinRoom({
        roomId,
        name: profileRef.current.name,
        color: profileRef.current.color,
        manifestVersion,
      });
      setActionError(null);
    } catch (e) {
      setActionError(msg(e));
    }
  }, [conn, roomId, manifestVersion]);

  // Join on connect / room change; leave the previous room cleanly.
  useEffect(() => {
    if (!active || !roomId) return;
    void join();
    return () => {
      try {
        void conn?.reducers.leaveRoom({})?.catch?.(() => {});
      } catch {
        /* connection already closed */
      }
    };
    // `connectionKey` re-joins after a reconnect.
  }, [active, roomId, join, conn, connectionKey]);

  // Heartbeat; if the server forgot us (e.g. after a reconnect), rejoin.
  useEffect(() => {
    if (!active || !roomId) return;
    const id = setInterval(() => {
      conn?.reducers
        .heartbeat({})
        .catch((e: unknown) => {
          if (/join a room first/i.test(msg(e))) void join();
        });
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [active, roomId, conn, join]);

  const me = useMemo(
    () => presenceRows.find((p) => p.identity.toHexString() === identityHex) ?? null,
    [presenceRows, identityHex]
  );
  const participants = useMemo(
    () => [...presenceRows].sort((a, b) => Number(a.joinedAt.microsSinceUnixEpoch - b.joinedAt.microsSinceUnixEpoch)),
    [presenceRows]
  );
  const annotations = useMemo(
    () => [...annotationRows].sort((a, b) => Number(a.createdAt.microsSinceUnixEpoch - b.createdAt.microsSinceUnixEpoch)),
    [annotationRows]
  );
  const room = roomRows[0] ?? null;
  const presenterHex = room?.presenter?.toHexString() ?? null;
  const presenter = useMemo(
    () => (presenterHex ? (presenceRows.find((p) => p.identity.toHexString() === presenterHex) ?? null) : null),
    [presenceRows, presenterHex]
  );
  const isPresenter = presenterHex !== null && presenterHex === identityHex;

  const run = useCallback(
    (fn: () => Promise<void> | undefined) => {
      Promise.resolve(fn()).catch((e: unknown) => setActionError(msg(e)));
    },
    []
  );

  const setProfile = useCallback(
    (p: Profile) => {
      if (!conn || !me) return;
      run(() => conn.reducers.setProfile({ name: p.name, color: p.color }));
    },
    [conn, me, run]
  );

  const publishView = useCallback(
    (v: SharedView) => {
      if (!conn || !me) return;
      conn.reducers
        .updateView({
          ra: v.ra,
          dec: v.dec,
          zoom: v.zoom,
          yaw: v.yaw,
          pitch: v.pitch,
          activeLayer: v.activeLayer,
          spread: v.spread,
        })
        .catch(() => {
          /* view updates are best-effort; the next one supersedes this */
        });
    },
    [conn, me]
  );

  const claimPresenter = useCallback(() => {
    if (conn) run(() => conn.reducers.claimPresenter({}));
  }, [conn, run]);

  const releasePresenter = useCallback(() => {
    if (conn) run(() => conn.reducers.releasePresenter({}));
  }, [conn, run]);

  const addAnnotation = useCallback(
    async (a: { ra: number; dec: number; bin: number; text: string }) => {
      if (!conn) return false;
      try {
        await conn.reducers.addAnnotation(a);
        return true;
      } catch (e) {
        setActionError(msg(e));
        return false;
      }
    },
    [conn]
  );

  const deleteAnnotation = useCallback(
    (id: bigint) => {
      if (conn) run(() => conn.reducers.deleteAnnotation({ id }));
    },
    [conn, run]
  );

  const status: ConnStatus = state.connectionError ? 'error' : active ? 'connected' : 'connecting';

  return {
    status,
    connectionError: state.connectionError ? state.connectionError.message : null,
    actionError,
    clearActionError,
    identityHex,
    joined: me !== null,
    room,
    participants,
    annotations,
    me,
    presenter,
    isPresenter,
    setProfile,
    publishView,
    claimPresenter,
    releasePresenter,
    addAnnotation,
    deleteAnnotation,
  };
}
