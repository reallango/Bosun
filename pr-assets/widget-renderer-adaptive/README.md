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
