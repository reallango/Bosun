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
- In a cluster, only the database leader polls (see *Clustering*).

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
| `NODE_NAME`, `RQLITE_ADV_HOST`, `RQLITE_JOIN`, `RQLITE_BOOTSTRAP_EXPECT` | Clustering (see *Clustering*). |
| `RQLITE_FORCE_SINGLE` | `1` = disaster recovery: make this node a single-node cluster (see *Clustering*). |
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

Use **Wake** on the servers list, the server's edit page or its dashboard toolbar.

**MAC addresses are detected.** When a server is added (manually or through automatic
setup), its first poll reads the host's physical network interfaces:
- *Primary MAC*: the NIC that carries the address Bosun's SSH connection arrived on.
- *Alternate MAC*: the wired/wireless counterpart, for machines that move between
  Ethernet and Wi-Fi.

Both fields only need editing if detection picked the wrong NIC or the hardware changed.
The edit form shows what the host currently reports, with one-click "use detected" and
"auto-detect" actions. A wake sends packets to the primary and alternate MACs and to
whatever the host last reported.

**Packets are sent from the right host.** A magic packet only reaches a sleeping machine
from the same L2 segment, which a bridged container is not. Under Settings → General →
Wake-on-LAN the default sender is *the host this Bosun node runs on*, over SSH with
`wakeonlan`. Bosun detects that host by finding its own container among the Docker
containers it monitors on each server, so the Docker host must be added as a server. You
can also map it by hand. The mapping is per node (`NODE_NAME`), so in a multi-node setup
every node sends from its own host, which is up whenever that node is. If that host
cannot be reached, the packet is sent from the container instead. You can also choose a
fixed server or the container.

If `wakeonlan` is missing on the sending host, admins are offered to install it (needs
passwordless sudo).

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

## Clustering

Bosun can run as several nodes that share one replicated database (rqlite/Raft).
Every node serves the full UI and API; any node can be used.

- **One master.** The nodes elect a database leader. Only the leader's poller
  collects data. The others idle, checking every 3 s whether they have become leader,
  and serve the same data from the shared database. Writes made on any node are
  forwarded to the leader.
- **Failover.** If the leader dies, the remaining nodes elect a new one, normally
  within a few seconds, and its poller takes over. In testing, polling resumed 3 s
  after the leader was killed. A returning node rejoins as a follower and catches up.
- **Use three nodes.** Raft needs a majority of voting nodes to have a leader: 2 of 3,
  3 of 5. A 2-node cluster stops when either node fails, so it is worse than one node.
  With 3 nodes, any one can fail.
- **Only one node left (no majority).** By design there is no automatic failover to
  one node. A node cannot tell "the others are dead" from "I am cut off from them",
  and two halves both carrying on would diverge. Instead the isolated node goes
  **read-only**:
  - it serves the last replicated data, read from its local copy;
  - polling stops;
  - saves and logins answer `503 NO_QUORUM` with an explanation (signed-in users keep
    access, since token refresh is read-only);
  - a red banner explains the state, and `/api/health` reports `degraded`.

  When any other node comes back, a leader is elected and everything resumes
  automatically. Settings → Cluster shows the leader, reachable nodes, quorum and which
  node is polling. An amber banner appears whenever a node is down.
- **Disaster recovery.** Use this only if the other nodes are permanently gone and you
  need this one writable again. Restart it with `RQLITE_FORCE_SINGLE=1`; it rewrites the
  Raft membership to just itself and becomes leader with all its data. Then add fresh
  nodes (empty data volumes) with the usual join settings to get back to three. The
  switch is applied once per data volume, so leaving it set cannot undo the rebuilt
  cluster, but remove it anyway.

Setting up three nodes: run `docker-compose.cluster.yaml` on each machine with an
`.env` like this:

```bash
NODE_NAME=n1                         # n2, n3 on the other machines
RQLITE_ADV_HOST=192.168.1.161        # this machine's LAN address
RQLITE_JOIN=192.168.1.161:4002,192.168.1.131:4002,192.168.1.171:4002
MASTER_KEY=...                       # identical on all nodes
AUTH_SECRET=...                      # identical on all nodes
```

All three start with the same join list and `RQLITE_BOOTSTRAP_EXPECT=3`, and form the
cluster together once all are up. Ports 4001 and 4002 must be reachable between the
nodes and should be firewalled from everything else.

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
  widgets) and version 3 (second MAC, per-node WoL sender) upgrade earlier versions in place automatically. To roll back, run the
  previous image against the previous volume or backup. The old image cannot read
  a 2.0 database.
