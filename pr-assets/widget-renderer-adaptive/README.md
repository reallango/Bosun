# Widget renderer adaptive screenshots

Rendered from the `oh/widget-renderer-adaptive` branch with a temporary demo route that mounts the real
`LayoutBlocks` renderer and the real dialog shell with synthetic host data.

- `footer-info-line.png` — `footer` on a `stat` block: "Mounts 2 · eth0 192.168.1.130 · Uptime 31d 6h".
- `alternatives.png` — one tile with `when` + `alternatives`: errors when there are any, average uptime otherwise.
- `meters-grid-16-cores.png` — `meters` with `layout: "grid"` and 16 cores.
- `meters-grid-64-cores.png` — the same block with 64 cores.
- `meters-fill-height.png` — the same four mounts in a tall and a short widget; bars and text scale with the height.
- `settings-dialog-1080p.png` — the settings dialog scrolled to the end at desktop width; the last help text is clear of the footer.
- `settings-dialog-phone.png` — the same dialog at phone width.

## Arrangement (balanced rows)

Shot from the dashboard itself, with a throwaway package imported into a local dev instance (the package lives in
neither the repository nor the images): four ring gauges in one widget type and six stat tiles in another, the tiles
carrying a `footer` info line so the arrangement is shown next to it. Each image is one widget resized on the grid.

- `arrangement-2-gauges-wide.png` / `arrangement-2-gauges-tall.png` — 2 gauges: 2x1 wide, 1x2 tall.
- `arrangement-3-gauges-wide.png` / `arrangement-3-gauges-tall.png` — 3 gauges: 3x1 wide, 1x3 tall (never 2 + 1).
- `arrangement-4-gauges-wide.png`, `arrangement-4-gauges-square.png`, `arrangement-4-gauges-tall.png` — 4 gauges: 4x1, 2x2, 1x4.
- `arrangement-6-tiles-wide.png`, `arrangement-6-tiles-square.png`, `arrangement-6-tiles-tall.png` — 6 tiles: 3x2, 2x3, 1x6, with the footer line under the grid.
