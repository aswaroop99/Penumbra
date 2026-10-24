import { DbConnection } from '../generated';

export const STDB_URI: string = import.meta.env.VITE_SPACETIMEDB_URI ?? 'ws://localhost:3000';
export const STDB_DB: string = import.meta.env.VITE_SPACETIMEDB_DB ?? 'penumbra';
export const DEFAULT_ROOM: string = import.meta.env.VITE_DEFAULT_ROOM ?? 'penumbra-demo';

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

export const connectionBuilder = DbConnection.builder()
  .withUri(STDB_URI)
  .withDatabaseName(STDB_DB)
  .withToken(readToken())
  .withAutomaticReconnect()
  .onConnect((_conn, _identity, token) => writeToken(token))
  .onConnectError(() => {
    // A stale token (e.g. after the database was recreated) must not wedge reconnects.
    writeToken(null);
  });
