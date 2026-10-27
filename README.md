# Bosun

Self-hosted, widget-based monitoring and light management for a handful of
Linux and Windows hosts: CPU/memory/disk/network/GPU, Docker containers, Ollama
models, services, OS updates, an in-browser SSH terminal and metric history.
Hosts are reached over plain SSH; nothing is installed on them.

## Architecture

One container, supervised by s6-overlay:

| Process | Role |
| --- | --- |
| `rqlited` | Database (SQLite replicated with Raft; one node is fine). |
| `poller.js` | The only process that collects monitoring data. One persistent SSH connection per host, one batched command per poll. Writes snapshots and metrics. |
| `next start` | Web UI and API. Reads what the poller stored; opens SSH only for user actions (container control, model pull/delete, custom commands). |
| `ws-server.js` | WebSocket bridge for the interactive terminal (host shells and `docker exec`). |
| `nginx` | Serves everything on port 3042 (`/ws/` to ws-server, the rest to Next). |

### Polling and impact on monitored hosts

The poller is built to be unnoticeable on the hosts it watches:

- **One connection per host**, kept open with SSH keepalives and reused for every
  poll. Commands are multiplexed as channels over it; there are no per-poll logins.
- **One exec per poll.** A read-only POSIX `sh` script is sent on stdin and prints
  every probe under a marker. It runs at `nice 19` and `ionice` idle.
  Windows hosts get a single `powershell -EncodedCommand` run at BelowNormal priority.
- **Tiered probes.** `/proc` counters, load, temperature and `nvidia-smi` every poll
  (default 15 s, 30 s on Windows). Disks, IPs, `docker ps` and the local Ollama API
  every minute. systemd services and OS facts every 5 minutes. Package updates
  (`apt-get -s upgrade`, a simulation) every 6 hours.
- **No sleeping on the host.** CPU % and network throughput are computed from counter
  deltas between polls.
- **Backoff.** Failures back off exponentially up to 5 minutes and drop the connection.
  A host is marked offline after two consecutive failures and its last error is shown.
- **Host keys** are pinned on first use. A changed key is refused until you clear the
  stored fingerprint (Edit server → reset host key).
- In a cluster, only the Raft leader polls.

Widgets read the latest snapshot from the database, so opening dashboards costs the
hosts nothing. "Refresh" on a widget asks the poller for an immediate full poll.

### Data and statistics

| Table | Contents |
| --- | --- |
| `host_snapshots` | Latest JSON per host and section (`cpu_memory`, `disks`, `network`, `gpus`, `docker`, `ollama`, `services`, `system`, `updates`). |
| `metric_samples` | Raw numeric samples (CPU %, memory, swap, network in/out, root and fullest disk, load, CPU temperature, running containers, loaded models, per-GPU utilisation/VRAM/temperature/power). Kept 48 h by default. |
| `metric_rollups` | 5-minute (30 days) and 1-hour (400 days) avg/min/max, updated incrementally with every sample, so there is no separate downsampling job. |

Retention is configurable under Settings → Database. The **Statistics** page compares a
metric across hosts. The **Metrics History** widget charts a host's metrics. Queries pick
raw samples, 5-minute or 1-hour rollups depending on the range and return at most ~400
points.

### Schema management

The schema is versioned (`schema_migrations`); the web app creates or upgrades it at
startup, each migration in one atomic transaction. Settings → Database shows a health
report: readiness, a write round-trip, schema version, tables, seeded config,
`PRAGMA quick_check`, and whether every polled host reported recently.

Databases created before the 2.0 schema are **not migrated**. Start with an empty
volume, or set `BOSUN_DB_RESET=1` once to drop the legacy tables. This only ever
applies to a legacy schema, so leaving the variable set is harmless.

## Running

```bash
cp .env.example .env    # set MASTER_KEY and AUTH_SECRET (openssl rand -base64 48)
docker compose up -d --build
```

Open `http://<host>:3042`. The first visit runs setup and creates the admin account.

| Variable | Purpose |
| --- | --- |
| `MASTER_KEY` | **Required.** Encrypts stored SSH private keys. Changing it makes stored keys unreadable. |
| `AUTH_SECRET` | **Required.** Signs login and terminal tokens. Production refuses to start without it. |
| `COOKIE_SECURE` | `true` when served over HTTPS (e.g. behind Cloudflare). |
| `NODE_NAME`, `RQLITE_JOIN`, `RQLITE_HTTP_ADV`, `RQLITE_RAFT_ADV` | rqlite clustering (optional). |
| `BOSUN_PORT` | Published port (default 3042). |
| `BOSUN_DB_RESET` | `1` drops a legacy (pre-2.0) schema once. |

All services except nginx run as the unprivileged `node` user inside the container.

### Adding hosts

1. Settings → SSH Keys → generate a key and add its public key to the host account's
   `~/.ssh/authorized_keys` (or use *Provision* with a one-time password).
2. Settings → Servers → Add. The poller connects within a couple of seconds, detects
   the OS, CPU, RAM and capabilities (GPU, Docker, Ollama) and starts recording.

Requirements on Linux hosts: `sh`, `/proc`. Optional: `ip` (addresses), `nvidia-smi`,
`docker` (the SSH user in the `docker` group, or passwordless `sudo docker`),
`curl` (Ollama), `systemctl`. For installing OS updates the SSH user needs
passwordless `sudo` for the package manager.

### Windows hosts

Bosun runs PowerShell over the host's OpenSSH server, the same way
`Enter-PSSession -HostName <host> -SSHTransport` does.

1. Enable OpenSSH Server (Windows 10 1809+ / Server 2019+):

   ```powershell
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Start-Service sshd
   Set-Service -Name sshd -StartupType Automatic
   ```

2. Authorize the Bosun public key. For an administrator account it must go in
   `C:\ProgramData\ssh\administrators_authorized_keys`, with these ACLs:

   ```powershell
   icacls.exe "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
   ```

3. Add the server with **Platform: Windows**. CPU, memory, disks, network, services,
   `nvidia-smi` GPUs, Docker Desktop (`docker.exe`) and Ollama (`curl.exe` against
   `localhost:11434`) are collected. The terminal opens PowerShell.

A Windows poll starts a PowerShell process. The fast tier takes well under a second
of CPU, but it is costlier than the Linux script, so Windows hosts poll every 30 s by default.

### Wake-on-LAN

Give a server its MAC address (Add/Edit server), then use **Wake** on the servers list,
the server's edit page or its dashboard toolbar. A magic packet only reaches a sleeping
host from the same L2 segment, which the Bosun container usually is not. Under
Settings → General → Wake-on-LAN you can pick a managed "local server" (typically the
Docker host) that sends the packet with the `wakeonlan` utility over SSH instead.
If the utility is missing, admins are offered to install it (needs passwordless sudo).

### Custom widgets

Some widget types are defined in the database (`custom_widgets`) rather than compiled
in. Ollama Status is the first. Under Settings → Custom Widgets an admin can rename them,
change their default size and refresh interval, restrict them to Linux or Windows, or
disable them, without a rebuild. A new type still needs a data source (a snapshot-section
mapping in `src/lib/widgets/snapshot-data.ts`) and a component
(`src/components/widgets/custom-registry.tsx`). Widgets can also declare settings fields
(`configSchema`), which the widget settings dialog renders and stores in the widget's config.
For example, Custom Command's command and Services' filter work this way.

**OS Update Check** shows the poller's package check: count, security updates, pending
reboot and versions. "Check for updates" makes the poller run the check right away
instead of waiting for the 6-hour schedule.

## Management actions and permissions

| Role | Can |
| --- | --- |
| viewer | View dashboards, statistics, container and model lists. |
| operator | Edit dashboards and widgets, container logs, custom commands, host terminals, Wake-on-LAN. |
| admin | Everything, including container start/stop/restart and shells, Ollama pull/delete, OS update install, installing wakeonlan, custom widget types, servers, keys and settings. |

Destructive actions require a confirmation in the UI, which the API enforces with
`confirm: true`. Deleting a model also requires typing its name. These actions are
rate limited (20/min per user) and written to the audit log. Container references and
model names are validated before they reach a shell.

## Development

```bash
npm ci
npm run dev          # Next.js on :3000 (needs rqlite on :4001)
npm run ws           # terminal websocket server on :3002
node poller.js       # collector (needs MASTER_KEY)
npm test             # vitest unit tests
npm run typecheck && npm run lint
```

Shared collector code lives in `src/lib/collect/` as dependency-free CommonJS so
`poller.js`, `ws-server.js` and the Next.js server use the same implementation.

## Upgrading and rolling back

- Back up first: Settings → Database → Export, or copy the `bosun-data` volume.
- The 2.0 schema is a fresh start (see *Schema management*); version 2 (Wake-on-LAN, custom
  widgets) upgrades version 1 in place automatically. To roll back, run the
  previous image against the previous volume or backup. The old image cannot read
  a 2.0 database.
