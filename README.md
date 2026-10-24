# Penumbra
Dark Matter Mapping hell yeahh

## Live backend (SpacetimeDB)

Only small room state lives in SpacetimeDB: rooms, presence, the presenter's shared view,
and sky-anchored annotations. Map PNGs / raw grids stay in `data/` and are never stored in the database.
Local mode needs no account or API key.

```sh
# one-time: install the CLI  (https://spacetimedb.com/install)
npm install && (cd spacetimedb && npm install)

npm run stdb:start      # terminal 1: local server on ws://localhost:3000
npm run stdb:publish    # build + publish module as database "penumbra"
npm run stdb:generate   # regenerate typed client bindings into src/generated/
npm run test:backend    # integration tests against the running server (two independent clients)
```

Reset the local database: `spacetime publish --server local --module-path spacetimedb penumbra --delete-data --yes`.

### Data model (`spacetimedb/src/index.ts`)

| Table | Key | Purpose |
|---|---|---|
| `room_state` | `room_id` | map `manifest_version`, presenter identity, presenter's shared camera (`view_ra/dec/zoom/yaw/pitch`), `active_layer`, `spread` |
| `presence` | `identity` | one row per connected participant: name, colour, their own view centre + active layer, heartbeat |
| `annotation` | `id` | sky-anchored flag: `(ra, dec, bin)`, text, author, `manifest_version` |

Canonical coordinates are celestial `(ra, dec, bin)`; clients convert to/from plane coordinates.

### Reducers

`join_room`, `leave_room`, `heartbeat`, `set_profile`, `update_view`, `claim_presenter`,
`release_presenter`, `add_annotation`, `delete_annotation`.

- Rooms are created on first join and bound to the joiner's `manifest_version`; joining with a different
  version is rejected, so flags can't attach to an incompatible map.
- `update_view` always updates the caller's presence; it only updates the shared room view for the presenter.
  Clients should throttle it (~5–8 Hz presenter, ~1–2 Hz others).
- Only the author can delete an annotation. Limits: 280 chars/comment, 50 flags/user, 500/room.
- Disconnect removes presence and releases the presenter role. Rooms with no participants and no
  annotations are deleted automatically.
- Identity is an anonymous token. The planned client keeps it per browser tab (`sessionStorage`).

Remote publishing later: `spacetime login` (browser OAuth), then publish with `--server maincloud`.
