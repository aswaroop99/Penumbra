import './cosmic.css';
import { cosmicContext } from '../guide/context';
import { mountGuide } from '../guide/panel';
import { Collab, DEFAULT_ROOM, STDB_URI, type CollabState, type Profile, type SharedView } from '../collab/client';
import { initialProfile, saveProfile } from '../collab/profile';
import type { Annotation } from '../generated/types';
import { el } from '../lib/dom';
import { loadManifest, manifestVersion, type Manifest } from '../lib/manifest';
import { cleanRoomName } from '../lib/room';
import { throttle } from '../lib/throttle';
import { CosmicApp, type SkyPlace } from './CosmicApp';
import { sameView, tabLabel } from './viewCodec';

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const STATUS_LABEL = { connecting: 'Connecting…', connected: 'Connected', error: 'Offline' } as const;

function initialRoom(): string {
  const q = new URLSearchParams(location.search).get('room');
  return (q && cleanRoomName(q)) || cleanRoomName(DEFAULT_ROOM) || 'penumbra-demo';
}

function showFatal(title: string, message: string, retry?: () => void) {
  const box = $('loading');
  box.hidden = false;
  box.replaceChildren(el('h1', { textContent: title }), el('p', { textContent: message }));
  if (retry) box.append(el('button', { className: 'btn', textContent: 'Try again', onclick: retry }));
}

async function start() {
  let manifest: Manifest;
  try {
    manifest = await loadManifest();
  } catch (e) {
    showFatal('Couldn’t load the map', e instanceof Error ? e.message : String(e), () => location.reload());
    return;
  }
  // Rooms are bound to this string; the cosmic-web page shares views differently from the
  // layer viewer, so it must not share rooms with it.
  const version = `${manifestVersion(manifest)}-cw`;

  let following = false;
  let annotateMode = false;
  let draft: SkyPlace | null = null;
  let focusAnnotation: bigint | null = null;
  let roomId = initialRoom();
  let profile = initialProfile();
  let state: CollabState | null = null;
  let lastFollowed = 0n;
  let lastSent: SharedView | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  // Assigned once the backend is wired up; the app can emit frames before that.
  let publish: () => void = () => {};

  // ------------------------------------------------------------------ app
  let app: CosmicApp;
  try {
    app = new CosmicApp(manifest, {
      onInteract: () => setFollowing(false),
      onFrame: () => publish(),
      onTabChange: () => renderCollab(),
      onPlace: (p) => {
        setNotice(null);
        draft = p;
        app.setDraft(p);
        renderComposer();
      },
      onNotice: (m) => setNotice(m),
    });
    await app.start();
  } catch (e) {
    showFatal('Couldn’t start the viewer', e instanceof Error ? e.message : String(e), () => location.reload());
    return;
  }
  $('loading').remove();
  mountGuide({ page: 'cosmic', getContext: cosmicContext });
  if (import.meta.env.DEV) (window as unknown as { __cosmic?: CosmicApp }).__cosmic = app; // debugging only

  // -------------------------------------------------------------- backend
  const collab = new Collab(profile, version);

  // Publish our view: frequent while presenting, sparse otherwise (presence only).
  publish = throttle(
    () => {
      const next = app.getView();
      if (lastSent && sameView(lastSent, next)) return;
      lastSent = next;
      collab.publishView(next);
    },
    () => (state?.isPresenter ? 120 : 700)
  );

  function setFollowing(on: boolean) {
    if (following === on) return;
    following = on;
    if (on) {
      lastFollowed = 0n; // apply the current shared view immediately
      applyFollow();
    }
    renderCollab();
  }

  /** While following, move to the presenter's latest shared view (once per room update). */
  function applyFollow() {
    const room = state?.room;
    if (!following || !room || !state?.presenter || state.isPresenter) return;
    const stamp = room.updatedAt.microsSinceUnixEpoch;
    if (stamp === lastFollowed) return;
    lastFollowed = stamp;
    void app.applyView(
      {
        ra: room.viewRa,
        dec: room.viewDec,
        zoom: room.viewZoom,
        yaw: room.viewYaw,
        pitch: room.viewPitch,
        activeLayer: room.activeLayer,
        spread: room.spread,
      },
      250
    );
  }

  function flyToFlag(a: Annotation) {
    setFollowing(false);
    focusAnnotation = a.id;
    void app.flyToFlag(a);
    renderFlags();
  }

  collab.onChange((s) => {
    const joinedNow = !!s.joined && !state?.joined;
    const presenterNow = s.isPresenter && !state?.isPresenter;
    state = s;
    const presenterOther = s.presenter && !s.isPresenter ? s.presenter : null;
    if (following && (s.isPresenter || !presenterOther)) following = false;

    applyFollow();
    if (joinedNow || presenterNow) {
      // The room's shared view only changes when the presenter publishes, so push ours
      // right away instead of waiting for the next camera movement.
      lastSent = null;
      publish();
    }
    app.setAnnotations(s.annotations, focusAnnotation);
    renderCollab();
  });
  collab.setRoom(roomId);
  collab.connect();

  // ------------------------------------------------------- collab panel UI
  const roomInput = $<HTMLInputElement>('roomInput');
  const nameInput = $<HTMLInputElement>('nameInput');
  const colorInput = $<HTMLInputElement>('colorInput');
  const flagText = $<HTMLTextAreaElement>('flagText');
  roomInput.value = roomId;
  nameInput.value = profile.name;
  colorInput.value = profile.color;

  const drawer = $('collab');
  const toggle = $('roomToggle');
  const setDrawer = (open: boolean) => {
    drawer.hidden = !open;
    document.body.classList.toggle('collab-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.onclick = () => setDrawer(drawer.hasAttribute('hidden'));
  setDrawer(innerWidth >= 1100);

  const roomValid = () => cleanRoomName(roomInput.value) !== null;
  roomInput.oninput = () => renderRoomForm();
  $('roomForm').onsubmit = (e) => {
    e.preventDefault();
    const r = cleanRoomName(roomInput.value);
    if (!r || r === roomId) return;
    roomId = r;
    roomInput.value = r;
    setFollowing(false);
    cancelDraft();
    const url = new URL(location.href);
    url.searchParams.set('room', r);
    history.replaceState(null, '', url);
    collab.setRoom(r);
    renderRoomForm();
    renderCollab();
  };

  $('copyLink').onclick = async () => {
    const url = new URL(location.href);
    url.searchParams.set('room', roomId);
    const btn = $('copyLink');
    try {
      await navigator.clipboard.writeText(url.toString());
      btn.textContent = 'Link copied';
      setTimeout(() => (btn.textContent = 'Copy invite link'), 1500);
    } catch {
      window.prompt('Copy this invite link', url.toString());
    }
  };
  $('dismissError').onclick = () => collab.clearActionError();

  const commitProfile = (p: Profile) => {
    profile = p;
    saveProfile(p);
    collab.setProfile(p);
  };
  nameInput.onblur = () => {
    const n = nameInput.value.trim().replace(/\s+/g, ' ');
    if (!n || n.length > 32) {
      nameInput.value = profile.name;
      return;
    }
    nameInput.value = n;
    if (n !== profile.name) commitProfile({ ...profile, name: n });
  };
  nameInput.onkeydown = (e) => e.key === 'Enter' && nameInput.blur();
  colorInput.oninput = () => commitProfile({ ...profile, color: colorInput.value });

  $('share').onclick = () => (state?.isPresenter ? collab.releasePresenter() : collab.claimPresenter());
  $('follow').onclick = () => setFollowing(!following);

  $('annotate').onclick = () => setAnnotateMode(!annotateMode);
  function setAnnotateMode(on: boolean) {
    annotateMode = on;
    app.setAnnotateMode(on);
    if (on && app.tab !== 'slices') {
      setFollowing(false);
      void app.show('slices'); // flags live on the survey layers
    }
    if (!on) cancelDraft();
    setNotice(null);
    renderComposer();
    renderCollab();
  }
  function cancelDraft() {
    draft = null;
    app.setDraft(null);
    renderComposer();
  }
  $('cancelFlag').onclick = () => setAnnotateMode(false);
  flagText.oninput = () => ($<HTMLButtonElement>('postFlag').disabled = !flagText.value.trim());
  $('composer').onsubmit = async (e) => {
    e.preventDefault();
    if (!draft || !flagText.value.trim()) return;
    const btn = $<HTMLButtonElement>('postFlag');
    btn.disabled = true;
    const ok = await collab.addAnnotation({ ...draft, text: flagText.value });
    if (ok) {
      flagText.value = '';
      cancelDraft();
    } else {
      btn.disabled = false;
    }
  };
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (annotateMode || draft)) setAnnotateMode(false);
  });

  function setNotice(text: string | null) {
    const n = $('notice');
    clearTimeout(noticeTimer);
    n.hidden = !text;
    n.textContent = text ?? '';
    if (text) noticeTimer = setTimeout(() => (n.hidden = true), 5000);
  }

  function renderRoomForm() {
    const valid = roomValid();
    roomInput.setAttribute('aria-invalid', String(!valid));
    $('roomInvalid').hidden = valid;
    $<HTMLButtonElement>('roomJoin').disabled = !valid || cleanRoomName(roomInput.value) === roomId;
  }

  function renderComposer() {
    const composer = $('composer');
    composer.hidden = !draft;
    if (draft) {
      $('draftInfo').textContent =
        `RA ${draft.ra.toFixed(2)}° · Dec ${draft.dec.toFixed(2)}° · ${manifest.layers[draft.bin].name}`;
      $<HTMLButtonElement>('postFlag').disabled = !flagText.value.trim();
      flagText.focus();
    } else {
      flagText.value = '';
    }
  }

  function renderFlags() {
    const s = state;
    const list = $('flags');
    list.replaceChildren();
    if (!s) return;
    for (const a of s.annotations) {
      const swatch = el('span', { className: 'swatch' });
      swatch.style.background = a.authorColor;
      const main = el(
        'button',
        { className: 'flag-main', title: 'Show this flag', onclick: () => flyToFlag(a) },
        swatch,
        el('span', { className: 'flag-text' }, el('strong', { textContent: a.authorName }), ` ${a.text}`)
      );
      const li = el('li', { className: focusAnnotation === a.id ? 'focus' : '' }, main);
      if (a.author.toHexString() === s.identityHex) {
        const del = el('button', {
          className: 'link',
          textContent: '✕',
          title: 'Delete',
          onclick: () => collab.deleteAnnotation(a.id),
        });
        del.setAttribute('aria-label', 'Delete my flag');
        li.append(del);
      }
      list.append(li);
    }
  }

  function renderCollab() {
    const s = state;
    if (!s) return;
    $('dot').className = `dot ${s.status}`;
    $('status').textContent = STATUS_LABEL[s.status];
    $('roomLabel').textContent = roomId;
    $('roomCount').textContent = String(s.participants.length);
    const offline = $('offline');
    offline.hidden = s.status !== 'error';
    if (s.status === 'error') {
      offline.replaceChildren(
        `Can’t reach SpacetimeDB at ${STDB_URI}. The viewer still works locally; run `,
        el('code', { textContent: 'npm run stdb:start' }),
        '.'
      );
    }
    const err = $('actionError');
    err.hidden = !s.actionError;
    $('actionErrorText').textContent = s.actionError ?? '';

    $('peopleCount').textContent = String(s.participants.length);
    const people = $('people');
    people.replaceChildren();
    const presenterHex = s.room?.presenter?.toHexString() ?? null;
    for (const u of s.participants) {
      const idHex = u.identity.toHexString();
      const swatch = el('span', { className: 'swatch' });
      swatch.style.background = u.color;
      const li = el(
        'li',
        {},
        swatch,
        el('span', { className: 'name', textContent: `${u.name}${idHex === s.identityHex ? ' (you)' : ''}` }),
        el('span', { className: 'where', textContent: tabLabel(u.activeLayer) })
      );
      if (idHex === presenterHex) li.append(el('span', { className: 'badge', textContent: 'presenting' }));
      people.append(li);
    }
    if (s.participants.length === 0) {
      people.append(el('li', { className: 'dim', textContent: s.joined ? '' : 'Not in a room yet' }));
    }

    const canFollow = !!s.presenter && !s.isPresenter;
    const share = $<HTMLButtonElement>('share');
    share.textContent = s.isPresenter ? 'Stop sharing my view' : 'Share my view';
    share.disabled = !s.isPresenter && (!s.joined || (!!s.presenter && !s.isPresenter));
    const follow = $<HTMLButtonElement>('follow');
    follow.classList.toggle('active', following);
    follow.setAttribute('aria-pressed', String(following));
    follow.textContent = following ? 'Following' : 'Follow presenter';
    follow.disabled = !canFollow;
    const note = $('presenterNote');
    note.hidden = !(canFollow || following);
    note.textContent = following
      ? 'Move the view yourself to stop following.'
      : `${s.presenter?.name ?? ''} is presenting.`;

    $('flagCount').textContent = String(s.annotations.length);
    const annotate = $<HTMLButtonElement>('annotate');
    annotate.classList.toggle('active', annotateMode);
    annotate.setAttribute('aria-pressed', String(annotateMode));
    annotate.disabled = !s.joined;
    annotate.textContent = annotateMode ? 'Click a layer to place a flag (Esc to cancel)' : 'Add a flag';
    renderFlags();
  }
  renderRoomForm();
  renderCollab();
}

void start();
