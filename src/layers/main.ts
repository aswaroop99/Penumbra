import './styles.css';
import { layersContextTracker } from '../guide/context';
import { mountGuide } from '../guide/panel';
import { Collab, DEFAULT_ROOM, STDB_URI, type CollabState, type Profile, type SharedView } from '../collab/client';
import { initialProfile, saveProfile } from '../collab/profile';
import type { Annotation } from '../generated/types';
import { el } from '../lib/dom';
import { loadManifest, manifestVersion, type Manifest } from '../lib/manifest';
import { cleanRoomName } from '../lib/room';
import { throttle } from '../lib/throttle';
import { binColor, FlyViewer, hex, type HoverInfo, type PlaceInfo } from '../viewer/FlyViewer';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

const DEFAULT_READOUT = 'Hover over a layer to read κ';
const STATUS_LABEL = { connecting: 'Connecting…', connected: 'Connected', error: 'Offline' } as const;

/**
 * The layer viewer and the cosmic-web page use different shared-view encodings, so they
 * default to different rooms (and rooms are bound to a per-page map version).
 */
function initialRoom(): string {
  const q = new URLSearchParams(location.search).get('room');
  return (q && cleanRoomName(q)) || cleanRoomName(`${DEFAULT_ROOM}-layers`) || 'penumbra-layers';
}

function showFatal(title: string, message: string, retry?: () => void) {
  const box = $('loading');
  box.hidden = false;
  box.replaceChildren(el('h1', { textContent: title }), el('p', { textContent: message }));
  if (retry) box.append(el('button', { textContent: 'Try again', onclick: retry }));
}

async function start() {
  let manifest: Manifest;
  try {
    manifest = await loadManifest();
  } catch (e) {
    showFatal('Couldn’t load the map', e instanceof Error ? e.message : String(e), () => location.reload());
    return;
  }
  const version = manifestVersion(manifest);

  let following = false;
  let annotateMode = false;
  let draft: PlaceInfo | null = null;
  let focusAnnotation: bigint | null = null;
  let roomId = initialRoom();
  let profile = initialProfile();
  let state: CollabState | null = null;
  let lastFollowed = 0n;
  let lastSent: SharedView | null = null;
  // Assigned once the backend is wired up; the viewer can emit view changes before that.
  let publish: () => void = () => {};

  // ---------------------------------------------------------------- viewer
  const viewer = new FlyViewer(manifest, $('app'), {
    onViewChange: () => publish(),
    onInteract: () => setFollowing(false),
    onHover: (h) => ($('readout').textContent = describeHover(manifest, h)),
    onFocusChange: (i) => {
      syncFocusRadios(i);
      lastSent = null;
      publish();
    },
    onLayerShown: (i) => {
      const box = layerBoxes[i];
      if (box) box.checked = true;
    },
    onPlace: (p) => {
      setNotice(null);
      draft = p;
      viewer.setDraft(p);
      renderComposer();
    },
    onFlagClick: (a) => flyToFlag(a),
    onError: (m) => setNotice(m),
  });
  try {
    await viewer.load();
  } catch (e) {
    showFatal('Couldn’t load the map', e instanceof Error ? e.message : String(e), () => location.reload());
    return;
  }
  $('loading').remove();
  mountGuide({ page: 'layers', getContext: layersContextTracker(), launcherBottom: 56 });
  if (import.meta.env.DEV) (window as unknown as { __viewer?: FlyViewer }).__viewer = viewer; // debugging only
  $('panel').hidden = false;
  $('collab').hidden = false;

  // ------------------------------------------------------ viewer panel UI
  const { bounds } = manifest;
  $('source').textContent =
    `${manifest.source} · ${manifest.smoothing_arcmin}′ smoothing · RA ${bounds.ra_min}…${bounds.ra_max}°, ` +
    `Dec ${bounds.dec_min}…${bounds.dec_max}°`;
  $('note').textContent = manifest.note || 'Layers are mass projected toward more distant sources, not slices of space.';

  const layerBoxes: HTMLInputElement[] = [];
  const focusRadios: HTMLInputElement[] = [];
  manifest.layers.forEach((L, i) => {
    const box = el('input', { type: 'checkbox', checked: true });
    box.onchange = () => viewer.setLayerVisible(i, box.checked);
    const swatch = el('span', { className: 'swatch' });
    swatch.style.background = hex(binColor(i));
    const radio = el('input', { type: 'radio', name: 'focus', className: 'focus', title: 'Focus layer (shared with the room)' });
    radio.checked = i === viewer.getFocusLayer();
    radio.onchange = () => {
      if (!radio.checked) return;
      setFollowing(false);
      viewer.setFocusLayer(i);
    };
    layerBoxes.push(box);
    focusRadios.push(radio);
    $('layers').append(
      el(
        'div',
        { className: 'row' },
        el('label', {}, box, ' ', swatch, L.name),
        el('span', { className: 'dim', textContent: `σ=${L.sigma.toFixed(4)}` }),
        radio
      )
    );
  });
  const syncFocusRadios = (i: number) => focusRadios.forEach((r, k) => (r.checked = k === i));

  const spacing = $<HTMLInputElement>('spacing');
  spacing.value = String(viewer.getSpacing());
  spacing.oninput = () => {
    setFollowing(false);
    viewer.setSpacing(+spacing.value);
  };
  $<HTMLInputElement>('opacity').oninput = (e) => viewer.setOpacity(+(e.target as HTMLInputElement).value);
  $<HTMLInputElement>('showPeaks').onchange = (e) => viewer.setPeaksVisible((e.target as HTMLInputElement).checked);
  $('collapse').onclick = (e) => {
    const body = $('panelBody');
    const hide = body.style.display !== 'none';
    body.style.display = hide ? 'none' : '';
    const btn = e.target as HTMLButtonElement;
    btn.textContent = hide ? 'Show' : 'Hide';
    btn.setAttribute('aria-expanded', String(!hide));
  };
  $('reset').onclick = () => {
    setFollowing(false);
    viewer.reset();
  };

  [...manifest.peaks]
    .sort((a, b) => b.snr - a.snr)
    .slice(0, 15)
    .forEach((p) => {
      const swatch = el('span', { className: 'swatch' });
      swatch.style.background = hex(binColor(p.bin));
      const li = el(
        'li',
        {},
        el('span', {}, swatch, `RA ${p.ra.toFixed(1)}°, Dec ${p.dec.toFixed(1)}°`),
        el('span', { textContent: `S/N ${p.snr.toFixed(1)}` })
      );
      li.onclick = () => {
        setFollowing(false);
        viewer.flyToPeak(p);
      };
      $('peaks').append(li);
    });

  // -------------------------------------------------------------- backend
  const collab = new Collab(profile, version);

  // Publish our camera: frequent while presenting, sparse otherwise (presence only).
  publish = throttle(
    () => {
      const next = viewer.getView();
      const prev = lastSent;
      if (
        prev &&
        Math.abs(prev.ra - next.ra) < 0.01 &&
        Math.abs(prev.dec - next.dec) < 0.01 &&
        Math.abs(prev.zoom - next.zoom) < 0.01 &&
        Math.abs(prev.yaw - next.yaw) < 0.002 &&
        Math.abs(prev.pitch - next.pitch) < 0.002 &&
        prev.activeLayer === next.activeLayer &&
        prev.spread === next.spread
      ) {
        return;
      }
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
    spacing.value = String(room.spread);
    viewer.applyView(
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
    viewer.flyToSky(a.ra, a.dec, a.bin);
    if (state) viewer.setAnnotations(state.annotations, focusAnnotation);
    renderFlags();
  }

  collab.onChange((s) => {
    const joinedNow = !!s.joined && !state?.joined;
    state = s;
    const presenterOther = s.presenter && !s.isPresenter ? s.presenter : null;
    if (following && (s.isPresenter || !presenterOther)) following = false;

    applyFollow();
    if (joinedNow) {
      lastSent = null;
      publish();
    }

    const others = s.participants.filter((p) => p.identity.toHexString() !== s.identityHex);
    viewer.setOthers(others, s.room?.presenter?.toHexString() ?? null);
    viewer.setAnnotations(s.annotations, focusAnnotation);
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
    viewer.setAnnotateMode(on);
    if (!on) draft = null;
    setNotice(null);
    renderComposer();
    renderCollab();
  }
  function cancelDraft() {
    draft = null;
    viewer.setDraft(null);
    renderComposer();
  }
  $('cancelFlag').onclick = cancelDraft;
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
    n.hidden = !text;
    n.textContent = text ?? '';
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
        { className: 'flag-main', title: 'Fly to this flag', onclick: () => flyToFlag(a) },
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
    const offline = $('offline');
    offline.hidden = s.status !== 'error';
    if (s.status === 'error') {
      offline.replaceChildren(
        `Can’t reach SpacetimeDB at ${STDB_URI}. The map still works locally; run `,
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
        el('span', { className: 'name', textContent: `${u.name}${idHex === s.identityHex ? ' (you)' : ''}` })
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
      ? 'Move the map yourself to stop following.'
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

function describeHover(manifest: Manifest, h: HoverInfo | null): string {
  if (!h) return DEFAULT_READOUT;
  switch (h.kind) {
    case 'peak': {
      const p = h.peak;
      return `Peak · bin ${p.bin} · RA ${p.ra.toFixed(2)}°, Dec ${p.dec.toFixed(2)}° · κ ${p.kappa.toFixed(4)} · S/N ${p.snr.toFixed(2)}`;
    }
    case 'flag':
      return `Flag by ${h.annotation.authorName}: ${h.annotation.text}`;
    case 'loading':
      return `Loading ${manifest.layers[h.layer].name} values…`;
    case 'outside':
      return 'Outside survey footprint';
    case 'layer':
      return `${manifest.layers[h.layer].name} · RA ${h.ra.toFixed(2)}°, Dec ${h.dec.toFixed(2)}° · κ ${h.kappa.toFixed(4)} (${(h.kappa / h.sigma).toFixed(1)}σ)`;
  }
}

void start();
