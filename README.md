# Floaty territory history

A daily snapshot of every hexagon claimed by a club in
[Floaty](https://floaty-app.com/), the onewheel/PEV riding app, **for the whole
world**. Club members claim cells by riding through them. Floaty's map only
shows the current state, so this repo keeps the history.

A GitHub Action takes a snapshot every day at 00:17 UTC and commits it here.

## Web map

**Live: <https://floaty.klaska.net/>**

`site/` is a small static page (Leaflet + h3-js, no build step) that draws any
day's territory:
- **Zoom levels:** cells are dots when zoomed out, hexagons from zoom 9, one
  label per contiguous club patch from zoom 10, and the faint unclaimed grid
  from zoom 12.
- **Interaction:** hover a cell for its club and the date it last changed
  hands (from `changes.json`, loaded on the first hover). Click a club in the list (or on
  the map) to highlight it and zoom to its territory.
  Zoomed out (below zoom 10), the selected club's cells are gathered into
  numbered markers, one even for a lone cell, so outposts are easy to find;
  hover for the count, click to zoom in.
- **Club list:** every club with its cells and, since the previous day, the
  cells it gained (newly claimed or taken from another club), the cells it
  lost, and the net change (gained − lost); click a column header to sort by
  any of them.
- **Changes:** tick *Show only changes since the previous day* to grey out
  every cell the previous snapshot already had under the same club. Newly
  claimed cells and cells that changed hands keep their club's colour and
  labels, and the hover tip says *new* or *was \<club\>*.
  Zoomed out (below zoom 10), the changed cells are also gathered into
  numbered markers, so even a single changed hexagon stands out: the ring
  shows which clubs gained them, hovering lists the clubs (new or taken from
  another club), and a click zooms in on them.
  With a club selected, the cells it held the previous day and no longer does
  (taken by another club, or unclaimed now) are drawn in red, and the markers
  count them too.
- **Navigation:** ◀ ▶ (or Alt+←/→) step through the days.
- **My location:** the ⌖ button under the zoom buttons shows where you are (a
  dot with its accuracy circle, kept up to date while it's on) and brings the
  map there. The position is never stored or put in the URL.
- **Links:** the view is kept in the URL (`#d=<date>&c=<clubId>&diff=1&m=<zoom>/<lat>/<lng>`),
  so links are shareable.

It reads `index.json` and the daily files straight from the repo (via
`raw.githubusercontent.com`), so the published site stays tiny however long
the history gets, and a daily snapshot needs no deploy.

It is hosted on Cloudflare as an assets-only Worker (`wrangler.jsonc`, custom
domain `floaty.klaska.net`; response headers incl. the CSP in `site/_headers`).
`.github/workflows/deploy.yml` deploys it on every push to `main` that touches
`site/` or the tooling. Each pull request gets its own `workers.dev` preview
(`wrangler preview`), linked in a new PR comment per deploy with a QR code for
phones, Lighthouse scores of the preview, and a visual regression of fixed map views
against production (`tests/visual.spec.mjs`; a PR that changes the map on purpose
fails it by design, and the comment links a page with the differences). The preview
is deleted when the PR is closed. Same setup as https://cfsite.klaska.net. It needs
the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. By hand:
`npm ci && npx wrangler deploy`; the visual check:
`PREVIEW_URL=<url> npx playwright test`.

The old addresses still work: `klaska.net/floaty_territory_history/` is a 301 to
floaty.klaska.net (klaska.net's own `_redirects`), and
`radimklaska.github.io/floaty_territory_history/` is forwarded there by the
radimklaska.github.io redirect page. The `#…` link state survives both.

To try it locally, serve the repo root and point it at the local data:

```bash
python3 -m http.server 8000   # then open http://localhost:8000/site/?data=../
```

## Files

| Path | What |
|---|---|
| `daily/YYYY/YYYY-MM-DD.json` | the snapshot for that day (UTC date of the run) |
| `latest.json` | the newest snapshot; `git log -p latest.json` is a day-by-day diff of which cells changed hands |
| `index.json` | every day on file with its totals (the web map's date list) |
| `changes.json` | per cell, the dates its owner changed (claimed, taken, or unclaimed); rebuilt from `daily/` on every run by `changes.js` |
| `site/` | the web map |

Each file is pretty-printed, with clubs sorted by id and one cell per line, so
diffs stay readable. Files over 1 MB show as "View raw" on GitHub.

## Format

```json
{
  "date": "2026-10-08",
  "takenAt": "2026-10-08T00:17:31.120Z",
  "source": "https://cdn.floaty-app.com/territory-tiles",
  "h3Res": 8,
  "totals": { "cells": 63645, "clubs": 250, "unnamedCells": 1 },
  "clubs": {
    "<clubId>": { "name": "Czech riders", "color": "#22C55E", "cells": ["881e3...fffff", "…"] }
  },
  "unnamed": { "<color>": ["881e3...fffff"] }
}
```

- **Cells** are [H3](https://h3geo.org/) indexes at **resolution 8**: hexagons
  about 0.5 km across (0.74 km² on average). Turn one into its outline with any
  H3 library, e.g. `h3.cellToBoundary(id)` in
  [h3-js](https://github.com/uber/h3-js) or `h3.cell_to_boundary(id)` in Python.
- **`clubs`** is keyed by Floaty's club id; `name` and `color` are the club's
  as of that day (clubs can rename or recolour).
- **`unnamed`** holds claimed cells whose club the tiles didn't name, grouped by
  colour. Normally empty or a handful.

`changes.json` holds, for every cell ever claimed, the dates its owner changed:
claimed, taken by another club, or unclaimed. A date is the first snapshot that
showed the change, and a cell whose only date is `first` has kept its owner
since the first snapshot or earlier:

```json
{
  "first": "2026-10-08",
  "last": "2026-11-15",
  "cells": {
    "881e037aa1fffff": ["2026-10-08", "2026-10-11", "2026-10-16", "2026-10-18", "2026-11-07"]
  }
}
```

Quick look with `jq`:

```bash
jq -r '.clubs[] | "\(.cells | length)\t\(.name)"' latest.json | sort -rn | head
```

## How it's collected

Floaty draws territory from public Mapbox vector tiles on its CDN
(`https://cdn.floaty-app.com/territory-tiles/{z}/{x}/{y}.pbf`, zooms 5–14). No
account is needed, and nothing here touches riders' live locations. The tiles
hold a polygon per claimed cell and, from zoom 10 up, a label point with the
club's id and name. Floaty re-uploads changed tiles a couple of minutes past
each hour.

`snapshot.js`:

1. fetches all 1,024 zoom-5 tiles; fewer than 100 aren't 404s. They only
   show where to look: zoom 5 leaves out whole areas, returning an empty tile
   where there is territory (until 2026-11-19 this missed ~760 cells in
   Taiwan, South Florida, Buenos Aires and Singapore, see Caveats).
2. fetches the four zoom-6 tiles under each zoom-5 tile that isn't a 404
   (about 340). These list every claimed cell, but only with its colour;
   zoom 6 matches zoom 7 cell for cell.
3. fetches the zoom-10 tile holding each cell's centre (about 2,000 tiles),
   which names the cell's club.
4. maps each polygon back to its H3 index (from its centroid) and writes the
   snapshot. If any tile fails after 3 attempts, nothing is written and the
   run fails.
5. updates `index.json` and rebuilds `changes.json` from all the daily files
   (`changes.js`).

That's about 3,400 requests once a day.

Run it yourself (Node 22+):

```bash
npm ci
npm test
node snapshot.js            # writes daily/…, latest.json, index.json and changes.json here
node changes.js             # only rebuild changes.json from daily/
node snapshot.js /tmp/out   # or somewhere else
```

## Caveats

- A snapshot is what Floaty's tiles showed at run time. Claims made after the
  last hourly tile update show up the next day.
- Snapshots up to 2026-11-19 miss about 760 cells (about 1%): all of Taiwan
  and parts of South Florida, Buenos Aires and Singapore, where Floaty's zoom-5
  tiles were empty. The 2026-11-20 snapshot was retaken at 14:41 UTC with them
  read from zoom 6, so that day shows them as newly gained, and `changes.json`
  dates their last change to then. That can't be backfilled: the tiles only ever show the present.
- GitHub sometimes delays scheduled runs, or rarely skips one, so a day can be
  missing.
- The tile format is Floaty's internal format and may change without notice.
  If the action starts failing, that's the likely reason.

## Disclaimer

Not affiliated with, endorsed by, or supported by Floaty / Tech Foundry Ltd.
The territory data is Floaty's and its riders'. This repo only archives what
Floaty's public map already shows.
