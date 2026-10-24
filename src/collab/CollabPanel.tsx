import { useEffect, useState } from 'react';
import type { Annotation } from '../generated/types';
import type { Manifest } from '../lib/manifest';
import { cleanRoomName } from '../lib/room';
import { STDB_URI } from './connection';
import type { Profile, RoomApi } from './useRoom';
import type { Draft } from '../viewer/MapScene';

interface Props {
  api: RoomApi;
  roomId: string;
  onRoom: (room: string) => void;
  profile: Profile;
  onProfile: (p: Profile) => void;
  manifest: Manifest;
  following: boolean;
  onFollow: (on: boolean) => void;
  annotateMode: boolean;
  onAnnotateMode: (on: boolean) => void;
  draft: Draft | null;
  onDraftCancel: () => void;
  notice: string | null;
  onFly: (a: Annotation) => void;
  focusAnnotation: bigint | null;
  onPublished: () => void;
}

const STATUS_LABEL = { connecting: 'Connecting…', connected: 'Connected', error: 'Offline' } as const;

export function CollabPanel(p: Props) {
  const { api } = p;
  const [roomInput, setRoomInput] = useState(p.roomId);
  const [nameInput, setNameInput] = useState(p.profile.name);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => setRoomInput(p.roomId), [p.roomId]);
  useEffect(() => setNameInput(p.profile.name), [p.profile.name]);
  useEffect(() => {
    if (!p.draft) setText('');
  }, [p.draft]);

  const roomValid = cleanRoomName(roomInput) !== null;
  const myHex = api.identityHex;

  const commitName = () => {
    const n = nameInput.trim().replace(/\s+/g, ' ');
    if (!n || n.length > 32) {
      setNameInput(p.profile.name);
      return;
    }
    if (n !== p.profile.name) p.onProfile({ ...p.profile, name: n });
  };

  const copyLink = async () => {
    const url = new URL(location.href);
    url.searchParams.set('room', p.roomId);
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy this invite link', url.toString());
    }
  };

  const submitFlag = async () => {
    if (!p.draft || !text.trim() || busy) return;
    setBusy(true);
    const ok = await api.addAnnotation({ ...p.draft, text });
    setBusy(false);
    if (ok) {
      setText('');
      p.onPublished();
    }
  };

  const presenterName = api.presenter?.name;
  const canFollow = !!api.presenter && !api.isPresenter;

  return (
    <aside className="panel right" aria-label="Collaboration">
      <section>
        <h2>
          Room <span className={`dot ${api.status}`} title={STATUS_LABEL[api.status]} />
          <span className="status">{STATUS_LABEL[api.status]}</span>
        </h2>
        {api.status === 'error' && (
          <p className="small error-text">
            Can’t reach SpacetimeDB at {STDB_URI}. The map still works locally; run <code>npm run stdb:start</code>.
          </p>
        )}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const r = cleanRoomName(roomInput);
            if (r) p.onRoom(r);
          }}
        >
          <input
            value={roomInput}
            onChange={(e) => setRoomInput(e.target.value)}
            aria-label="Room name"
            aria-invalid={!roomValid}
            maxLength={40}
          />
          <button type="submit" disabled={!roomValid || cleanRoomName(roomInput) === p.roomId}>
            Join
          </button>
        </form>
        {!roomValid && <p className="small error-text">Use 1–32 letters, numbers or dashes.</p>}
        <button className="wide" onClick={copyLink}>
          {copied ? 'Link copied' : 'Copy invite link'}
        </button>
        {api.actionError && (
          <p className="small error-text" role="alert">
            {api.actionError}{' '}
            <button className="link" onClick={api.clearActionError}>
              dismiss
            </button>
          </p>
        )}
      </section>

      <section>
        <h2>You</h2>
        <div className="row">
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur(), undefined)}
            aria-label="Display name"
            maxLength={32}
          />
          <input
            type="color"
            value={p.profile.color}
            onChange={(e) => p.onProfile({ ...p.profile, color: e.target.value })}
            aria-label="Colour"
          />
        </div>
      </section>

      <section>
        <h2>People ({api.participants.length})</h2>
        <ul className="people">
          {api.participants.map((u) => {
            const hex = u.identity.toHexString();
            const isMe = hex === myHex;
            const isPresenter = api.room?.presenter?.toHexString() === hex;
            return (
              <li key={hex}>
                <span className="swatch" style={{ background: u.color }} />
                <span className="name">
                  {u.name}
                  {isMe ? ' (you)' : ''}
                </span>
                {isPresenter && <span className="badge">presenting</span>}
              </li>
            );
          })}
          {api.participants.length === 0 && <li className="dim">{api.joined ? '' : 'Not in a room yet'}</li>}
        </ul>
        <div className="row">
          {api.isPresenter ? (
            <button onClick={api.releasePresenter}>Stop sharing my view</button>
          ) : (
            <button onClick={api.claimPresenter} disabled={!api.joined || (!!api.presenter && !api.isPresenter)}>
              Share my view
            </button>
          )}
          <button
            className={p.following ? 'active' : ''}
            aria-pressed={p.following}
            disabled={!canFollow}
            onClick={() => p.onFollow(!p.following)}
          >
            {p.following ? 'Following' : 'Follow presenter'}
          </button>
        </div>
        {canFollow && !p.following && <p className="dim small">{presenterName} is presenting.</p>}
        {p.following && <p className="dim small">Move the map yourself to stop following.</p>}
      </section>

      <section>
        <h2>Flags ({api.annotations.length})</h2>
        <button
          className={`wide ${p.annotateMode ? 'active' : ''}`}
          aria-pressed={p.annotateMode}
          disabled={!api.joined}
          onClick={() => p.onAnnotateMode(!p.annotateMode)}
        >
          {p.annotateMode ? 'Click the map to place a flag (Esc to cancel)' : 'Add a flag'}
        </button>
        {p.notice && <p className="small error-text">{p.notice}</p>}
        {p.draft && (
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void submitFlag();
            }}
          >
            <p className="small dim">
              RA {p.draft.ra.toFixed(2)}° · Dec {p.draft.dec.toFixed(2)}° · {p.manifest.layers[p.draft.bin].name}
            </p>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="What do you see here?"
              maxLength={280}
              rows={3}
              autoFocus
            />
            <div className="row">
              <button type="submit" disabled={!text.trim() || busy}>
                Post flag
              </button>
              <button type="button" onClick={p.onDraftCancel}>
                Cancel
              </button>
            </div>
          </form>
        )}
        <ul className="flags">
          {api.annotations.map((a) => {
            const mine = a.author.toHexString() === myHex;
            return (
              <li key={String(a.id)} className={p.focusAnnotation === a.id ? 'focus' : ''}>
                <button className="flag-main" onClick={() => p.onFly(a)} title="Fly to this flag">
                  <span className="swatch" style={{ background: a.authorColor }} />
                  <span className="flag-text">
                    <strong>{a.authorName}</strong> {a.text}
                  </span>
                </button>
                {mine && (
                  <button
                    className="link"
                    onClick={() => api.deleteAnnotation(a.id)}
                    aria-label="Delete my flag"
                    title="Delete"
                  >
                    ✕
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}
