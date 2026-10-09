# Floaty territory history

A daily snapshot of every hexagon claimed by a club in
[Floaty](https://floaty-app.com/), the onewheel/PEV riding app, **for the whole
world**. Club members claim cells by riding through them. Floaty's map only
shows the current state, so this repo keeps the history.

A GitHub Action takes a snapshot every day at 00:17 UTC and commits it here.

## Web map

**Live: <https://klaska.net/floaty_territory_history/>**

`docs/` is a small static page (Leaflet + h3-js, no build step) that draws any
day's territory:
- **Zoom levels:** cells are dots when zoomed out, hexagons from zoom 9, one
  label per contiguous club patch from zoom 10, and the faint unclaimed grid
  from zoom 12.
- **Interaction:** hover a cell for its club. Click a club in the list (or on
  the map) to highlight it and zoom to its territory.
- **Changes:** tick *Show only changes since the previous day* to grey out
  every cell the previous snapshot already had under the same club. Newly
  claimed cells and cells that changed hands keep their club's colour and
  labels, and the hover tip says *new* or *was \<club\>*.
- **Navigation:** ◀ ▶ (or Alt+←/→) step through the days.
- **Links:** the view is kept in the URL (`#d=<date>&c=<clubId>&diff=1&m=<zoom>/<lat>/<lng>`),
  so links are shareable.

It reads `index.json` and the daily files straight from the repo (via
`raw.githubusercontent.com`), so the published site stays tiny however long
the history gets. To try it locally, serve the repo root and point it at the
local data:

```bash
python3 -m http.server 8000   # then open http://localhost:8000/docs/?data=../
```

## Files

| Path | What |
|---|---|
| `daily/YYYY/YYYY-MM-DD.json` | the snapshot for that day (UTC date of the run) |
| `latest.json` | the newest snapshot; `git log -p latest.json` is a day-by-day diff of which cells changed hands |
| `index.json` | every day on file with its totals (the web map's date list) |

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

1. fetches all 1,024 zoom-5 tiles; about 50 contain territory, the rest are
   404s. They list every claimed cell, but only with its colour.
2. fetches the zoom-10 tile holding each cell's centre (about 1,800 tiles),
   which names the cell's club.
3. maps each polygon back to its H3 index (from its centroid) and writes the
   snapshot. If any tile fails after 3 attempts, nothing is written and the
   run fails.

That's about 2,800 requests and 7 MB once a day.

Run it yourself (Node 22+):

```bash
npm ci
npm test
node snapshot.js            # writes daily/… and latest.json here
node snapshot.js /tmp/out   # or somewhere else
```

## Caveats

- A snapshot is what Floaty's tiles showed at run time. Claims made after the
  last hourly tile update show up the next day.
- GitHub sometimes delays scheduled runs, or rarely skips one, so a day can be
  missing.
- The tile format is Floaty's internal format and may change without notice.
  If the action starts failing, that's the likely reason.

## Disclaimer

Not affiliated with, endorsed by, or supported by Floaty / Tech Foundry Ltd.
The territory data is Floaty's and its riders'. This repo only archives what
Floaty's public map already shows.
