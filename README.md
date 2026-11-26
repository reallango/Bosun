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
| `ws-server.js` | WebSocket bridge for the interactive terminal (host shells and `docker exec`) and the API-key-only API terminal. |
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
cp .env.example .env    # optional: set MASTER_KEY and AUTH_SECRET (openssl rand -base64 48)
docker compose up -d --build
```

Open `http://<host>:3042`. The first visit runs setup: create the admin account, or
join an existing cluster with a join code (see *Clustering*).

| Variable | Purpose |
| --- | --- |
| `MASTER_KEY` | Encrypts stored SSH private keys, SMTP password and MFA seeds. If unset, Bosun generates one into `<data volume>/bosun/secrets.json`. Changing it makes stored secrets unreadable, so back up the data volume (or set it explicitly). |
| `AUTH_SECRET` | Signs login and terminal tokens. Generated like `MASTER_KEY` if unset. |
| `COOKIE_SECURE` | `true` when served over HTTPS (e.g. behind Cloudflare). |
| `TRUSTED_PROXIES` | Comma-separated addresses, CIDRs or host names of reverse proxies in front of Bosun (a cloudflared container, nginx, Traefik), e.g. `cloudflared` or `172.18.0.0/16`. A name (such as a container on the same Docker network) is looked up when Bosun starts and every minute, so it follows the container to a new address; the container log shows what it resolved to (`[trusted-proxies] cloudflared -> 172.18.0.5`). Only requests from these addresses may name the client in `X-Forwarded-For`; everyone else is identified by the address that connected. Login rate limits and audit entries use this address. Unset: no proxy is trusted. |
| `APP_URL` | Public address of Bosun (e.g. `https://bosun.example.com`). Emailed links (password reset) use *App URL* from Settings → General, else this; without either, no reset link is sent. |
| `NODE_NAME`, `RQLITE_ADV_HOST`, `RQLITE_JOIN`, `RQLITE_BOOTSTRAP_EXPECT` | Clustering (see *Clustering*). |
| `RQLITE_FORCE_SINGLE` | `1` = disaster recovery: make this node a single-node cluster (see *Clustering*). |
| `BOSUN_PORT` | Published port (default 3042). |
| `BOSUN_DB_RESET` | `1` drops a legacy (pre-2.0) schema once. |

All services except nginx run as the unprivileged `node` user inside the container.

Only port 3042 (nginx) is meant to be reached: the web app (3000) and the terminal server (3002) listen on the container's loopback only. A reverse proxy or tunnel must point at port 3042, not 3000 or 3002 (from 3000/3002 it would no longer connect). Behind one, add its address to `TRUSTED_PROXIES` so each visitor keeps their own login rate limit; otherwise every visitor coming through it shares one.

### Adding hosts

1. Settings → SSH Keys → generate a key and add its public key to the host account's
   `~/.ssh/authorized_keys` (or use *Provision* with a one-time password).
2. Settings → Servers → Add. The poller connects within a couple of seconds, detects
   the OS, CPU, RAM and capabilities (GPU, Docker, Ollama) and starts recording.

Requirements on Linux hosts: `sh`, `/proc`. Optional: `ip` (addresses), `nvidia-smi`,
`docker` (the SSH user in the `docker` group, or passwordless `sudo docker`),
`curl` (Ollama), `systemctl`. For installing OS updates, restarting and shutting
down the host, the SSH user needs passwordless `sudo`.

*Provision* sets that up for the service account it creates: it writes a
`/etc/sudoers.d/bosun-<account>` rule (`NOPASSWD:ALL`), checked with `visudo` before it is
installed, and adds the account to the `sudo` (Debian/Ubuntu) or `wheel` (RHEL-family)
group. Running Provision again on an existing account adds the rule too. If you add a
host with your own key and account instead, grant it passwordless sudo yourself.
Windows hosts have no sudo; the service account is an administrator.

**Docker.** The service account is added to the `docker` group only if the group exists. On a
host without Docker, Provision shows a warning instead; run it again after installing Docker
and the account is added then.

**Moving a host from another Bosun.** Each Provision run generates a new key. With *Replace
earlier Bosun keys on this host* ticked (the default), Bosun first adds and tests the new
key, then removes earlier Bosun keys. Nothing is removed if the new key cannot be verified.
The old Bosun install loses access to that host, so tick this when migrating and untick it
to run two installs side by side. If the host is already added to this Bosun, Provision
points it at the new key instead of creating a duplicate.

- **Linux:** removes the lines in the service account's `authorized_keys` whose comment ends
  in `-<account>`, which is how Bosun labels the keys it generates. Other keys on the account
  are left alone.
- **Windows:** every administrator shares one `C:\ProgramData\ssh\administrators_authorized_keys`,
  so this is stricter: only lines whose comment is *exactly* `<host>-<account>` are removed,
  where `<host>` is the hostname you typed. Keys that merely end in `-<account>` (an old Bosun
  that used a different host name, or another Bosun account) are kept and reported as a
  warning. The file is backed up as `administrators_authorized_keys.bosun-bak` first, edited
  in place (permissions untouched), re-read afterwards, and restored from the backup if the
  new key is not in it.

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

**OS updates.** The *OS Update Check* widget works on Windows hosts.

- *Checking* uses the Windows Update Agent API (software updates; drivers are not listed),
  every 6 hours and on demand from the widget's **Check for updates**. A scan takes 15 s to
  several minutes, so it runs as its own background command and can never delay a poll or
  make the host look offline. If the scan fails, the widget says so and shows the reason
  instead of "System up to date". Updates Microsoft rates, or files under *Security Updates*,
  count as security updates.
- *Installing* needs *Read + actions* access. Windows refuses to download or install updates
  for a remote session, and SSH counts as one, so Bosun runs the install as a one-off
  scheduled task under SYSTEM (`BosunWindowsUpdate`, script and result in
  `%ProgramData%\Bosun`) and follows its progress in the widget. It runs in the background,
  keeps going if you close the dashboard, and the host is **not** restarted automatically:
  the result says when a restart is needed (use **Restart** in the server's power menu).
  The service account must be an administrator, which *Provision* sets up. Each install
  request is audited as `server.updates_install`.

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

### Shutdown and restart

The power button on a server's dashboard toolbar opens a menu with **Wake**, **Restart** and
**Shut down**; the last two ask for confirmation and are audited (`server.power`). They need
*Read + actions* access. On Linux the SSH user needs passwordless sudo (`sudo -n`, the same
requirement as OS updates and container actions); Bosun reports it clearly when that is missing.
Windows hosts use `shutdown.exe`. The action is scheduled a few seconds out so the SSH command
returns before the host drops the connection. A shut-down server stays off until it is woken
(Wake-on-LAN) or started at the machine.

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
  cluster, but remove it anyway. Settings → Cluster → *Convert to single node* does the
  same from the UI.

### Managing the cluster from the UI

Settings → Cluster (admins) covers the whole lifecycle without editing `.env` files:

1. **Switch to multi-node.** On a single node, *Enable clustering* sets the address
   other nodes use to reach this one (LAN IP or DNS name) and optionally renames the
   node. The database restarts for a few seconds; data is kept.
2. **Add a node.** *Create join code* produces a code valid for 24 hours. Start Bosun
   on the new machine (`docker-compose.cluster.yaml` with ports 4001/4002 published,
   no join settings needed), open its setup page, choose **Join an existing cluster**
   and paste the code with that machine's address and a node name. No admin account is
   created there: the node discards its empty database, joins, and from then on uses
   the cluster's users, servers and settings. The code does not contain the cluster's
   secrets: it holds a one-time token that the new node exchanges (encrypted) at a
   member's Bosun web address for `MASTER_KEY` and `AUTH_SECRET`, so the new node must
   be able to reach a member on port 3042 (or the address you created the code from). A
   code works once and for 24 hours; a used or expired code is worthless. Joining is only
   offered on a node with no users and setup not completed. (A code from an older Bosun,
   `BOSUN-JOIN-1.`, still works for joining such a cluster; it did carry the secrets.)
3. **Remove a node.** The trash icon on a node row removes it from the membership
   (needs a leader). Reset that machine's data volume before reusing it.
4. **Convert to single node.** With a majority available the other nodes are removed
   through Raft; without one (the others are gone) this node's database restarts as a
   one-node cluster with its last data, like `RQLITE_FORCE_SINGLE`.

Settings made here are stored in `<data volume>/bosun/cluster.json` and take
precedence over `NODE_NAME`, `RQLITE_ADV_HOST` and `RQLITE_JOIN`, which remain the
defaults.

**Database authentication.** rqlite's HTTP API (port 4001) only answers requests that
carry Bosun's credentials; without them only `/readyz` responds. The password is
derived from `AUTH_SECRET`, so every node of a cluster gets it with the join code and
nothing has to be configured. The credentials are written to `/run/bosun/rqlite-auth.json`
inside the container on every start (not kept on the data volume). To use the `rqlite`
shell inside the container, read the user and password from that file.

**Node-to-node encryption.** Traffic between nodes on port 4002 (Raft replication and
requests forwarded to the leader) uses mutual TLS: it is encrypted, and only nodes
with a certificate from the cluster's CA can connect. The CA key is also derived from
`AUTH_SECRET`, so this needs no setup either. Each node makes its certificate on every
start in `/run/bosun/tls/`. `BOSUN_NODE_TLS=0` turns it off (not recommended; then every
node must have it off).

Upgrading an existing cluster to a version with database authentication or node-to-node
encryption: update all nodes together. A node that requires credentials or TLS and one
that does not cannot work with each other. The same release moves rqlite from 8.26.7 to
9.4.5 (8.x did not enforce client certificates). The database files are used as they are,
but export a backup first (Settings → Database).

**Firewall.** Keep ports 4001 and 4002 reachable only from the other cluster machines.
Ports that Docker publishes bypass `ufw`, so a `ufw` rule does not limit them. Either
publish them on the LAN address only (for example `192.168.1.161:4002:4002` instead of
`4002:4002`), or filter in the `DOCKER-USER` chain, which Docker checks first:

```bash
# On each node: allow 4001/4002 from the other nodes only (adjust the addresses).
for p in 4001 4002; do
  iptables -I DOCKER-USER -p tcp --dport $p -j DROP
  for ip in 192.168.1.131 192.168.1.171; do
    iptables -I DOCKER-USER -p tcp -s $ip --dport $p -j RETURN
  done
done
```

These rules are lost on reboot unless saved (for example with `iptables-persistent`).

### Setting up a cluster with environment variables

Alternatively, to set up three nodes: run `docker-compose.cluster.yaml` on each machine with an
`.env` like this:

```bash
NODE_NAME=n1                         # n2, n3 on the other machines
RQLITE_ADV_HOST=192.168.1.161        # this machine's LAN address
RQLITE_JOIN=192.168.1.161:4002,192.168.1.131:4002,192.168.1.171:4002
MASTER_KEY=...                       # identical on all nodes
AUTH_SECRET=...                      # identical on all nodes
```

All three start with the same join list and `RQLITE_BOOTSTRAP_EXPECT=3`, and form the
cluster together once all are up. `AUTH_SECRET` must be identical on all nodes, since
the database credentials and the node certificates are derived from it (see *Database
authentication* and *Node-to-node encryption*). Ports 4001 and 4002 must be reachable
between the nodes and should be firewalled from everything else (see *Firewall*).

## Access levels, users and API keys

Every user account and every API key has one of three access levels:

| Level | Role | Can |
| --- | --- | --- |
| Read only | `viewer` | View dashboards, statistics, live widget data, server and cluster status. |
| Read + actions | `operator` | Also run widget actions: container start/stop/restart and logs, Ollama pull/delete, OS update install, Wake-on-LAN, restarting and shutting down servers, forced refreshes, dashboard and widget edits. No shells, terminals or arbitrary commands. |
| Full access | `admin` | Everything: servers, SSH keys, host and container shells, command execution, custom commands, settings, alerts, users and API keys. |

### Permission groups

The level is the base. For finer control, **Settings → Permissions** (admins) manages
*permission groups*: named sets of individual permissions that are added **on top of** a
user's or API key's level. They can only add, never take away, so a level still behaves
exactly as described above when no group is involved.

- **Permissions** are single actions such as `power.restart`, `power.shutdown`,
  `updates.install`, `docker.containers.control`, `ollama.models.delete` or
  `commands.run`. Each system widget declares its own, so for the update widget you can
  allow *check* without *install*, and for Ollama allow *pull* without *delete*. Each one
  shows its risk (low, medium, high) and whether *Read + actions* already includes it.
  Installing a widget will register the permissions it declares, so they appear in the
  editor on their own.
- **Scope.** A grant applies to all servers, to one server, or to a **server group**.
- **Stacks and containers.** A widget package's permission can also be limited, on those
  servers, to some stacks or containers by name (a name ending in `*` matches by prefix, so
  `test-*` covers every stack starting with `test-`). A stack limit covers the stack and its
  containers. Actions that name what they act on (restart a container, deploy or update a stack,
  their logs and shell) are checked against it; lists show only the allowed stacks and containers;
  actions about the whole host (pull an image, prune, create a volume) need the permission for the
  whole server. Example: give an AI agent's API key *Docker: manage* limited to the stack
  `test-ai` on one server, and it can deploy, update and restart that stack and nothing else.
- **Expiry.** Any grant can have an end time; after it, the grant no longer counts (and it is
  deleted a week later).
### Importing stacks from Portainer

Stacks that another tool started (for example Portainer) can become Bosun stacks: **Settings → Servers → a server →
Import stacks**. Each is stored under the same project name, so its volumes (data) are kept; Docker Compose re-creates the
containers once from Bosun's copy, so importing is a short restart of the stack.

- **From Portainer** (needs Portainer's address and an API key from *My account → Access tokens*; tick *Accept a
  self-signed certificate* for Portainer's default HTTPS): the exact compose file and variables, or, for a stack Portainer
  deploys from git, the same repository, branch and file (private repositories use the Git credentials of the Docker widget).
- **Rebuilt from the containers** (no Portainer needed): a compose file written from the running containers, with values
  written out literally.
- **Detach from Portainer** is chosen per stack. Portainer cannot forget a stack without stopping it (its delete runs
  `docker compose down`, volumes kept), so Bosun first starts a small waiter on the host that brings the stack straight back
  from Bosun's copy, then deletes it in Portainer: one more short restart. Without detaching, Portainer keeps listing it, and it
  must not be redeployed or deleted there.
- **Detach later:** a stack imported without detaching is listed under *Bosun stacks Portainer still lists* (once Portainer
  is connected for that server), with **Detach from Portainer**: the same waiter, then Portainer's delete.
- Before anything starts, a confirmation says what the chosen options cost (for example: values written into the compose
  file when rebuilt from the containers, no git source to update from, two tools managing a stack that is not detached).
- **A node's own Bosun stack** can be imported (and detached) on that same node, which a single-node install needs
  (Docker widget 1.0.13 or newer). Bosun stores the stack and the widget starts it from a job on the host a few seconds
  later; Bosun restarts (again when it is detached), and the restarted Bosun reports the outcome in the bell about a minute
  after it is back. From another node's Bosun it works as for any other stack, without the restart of the page you use.

The outcome of each import and detach appears in the bell.
### Access requests (for agents and people)

An API key or user that lacks something can ask for it instead of being given broad access up front:

1. **Discover.** `GET /api/access` lists what the caller holds (including stack/container limits and expiries),
   every permission with its risk and whether it can be limited to a stack or container, the servers it can see,
   its own requests, and examples of both kinds of request. Every 403 for a missing permission also includes the
   exact body to send.
2. **Ask.** `POST /api/access-requests` with either
   - `{ "kind": "grant", "permission": "...", "server_id": "...", "resource": { "kind": "stack", "name": "test-ai" }, "duration_hours": 8, "reason": "..." }`
     (leave out `server_id` for all servers, `resource` for the whole server, `duration_hours` for a permanent grant), or
   - `{ "kind": "one_time", "server_id": "...", "widget_type": "...", "action_id": "...", "params": { ... }, "reason": "..." }`:
     one widget action, run once, exactly with these parameters.
3. **Decide.** The request appears in the bell with **Approve** and **Deny** (and under Settings → Access requests).
   Whoever decides must be signed in (never an API key), must not be the requester, must hold the permission there
   themselves, and needs Full access for high-risk permissions.
4. **Result.** An approved grant goes into a permission group "Approved requests: <name>" (with its expiry), which
   can be edited or deleted like any group. An approved one-time action runs at once, as the requester (its task
   and audit entry name them and the approver).
5. **Hearing back.** The requester reads the outcome with `GET /api/access-requests/{id}`: the status, who decided,
   their note and (one-time actions) the action's answer. Adding `?wait=50` holds the call open until the request is
   decided (at most 50 seconds, then it answers `pending`; ask again), so an agent need not poll. People also get the
   decision in their own bell, and so does the person who created an API key when that key's request is decided
   (only they see it).

Requests expire after 24 hours; a requester can have at most 10 pending, and can withdraw one with
`DELETE /api/access-requests/{id}`. Example flow for an agent: ask once to run *Deploy stack* for `test-ai`, then
ask for *Docker: manage* limited to the stack `test-ai` to keep working on it, without ever holding Docker access
for the whole host.
  Server groups are optional named sets of servers (a server can be in several); create
  them on the same page, or skip them and grant per server.
- **Who holds a group.** Assign groups to a user (Settings → Users) or to an API key
  (Settings → API Access). A person's permissions are the union of their level and all
  their groups. Changes apply within about 30 seconds on other cluster nodes, at once on
  the node where you make them.
- **Example.** A *Read only* API key in a group that holds *Restart a server* for one machine
  can read everything and restart just that machine, and nothing else.

The API enforces permissions on its own; the UI only hides controls the user cannot use.
A denied request returns `403` with `{"error": {"code": "FORBIDDEN", "permission": "power.restart", ...}}`
so a client (or an AI agent) can see exactly which permission is missing. `GET /api/auth/me`
lists, for the signed-in user, each permission they hold and the server ids it covers
(`"*"` = every server). Full access holds every permission, including ones added later.
Permission groups are included in backups.

**Users** (Settings → Users, admins): create accounts, change their level, disable
them (signed-in sessions stop within 30 s), or reset their password. The last active
admin cannot be demoted or disabled. Everyone manages their own profile, password and
two-step verification under **My Account**.

**API keys** (Settings → API Access, admins) let scripts and AI agents use the API
without a browser session, for example to give an assistant read-only or
read-plus-actions access to the servers without SSH access:

```bash
curl -H "Authorization: Bearer bosun_..." http://<host>:3042/api/servers
```

The key is shown once; only its hash is stored. Keys can expire and be revoked, and
are limited to 300 requests per minute. Keys never reach the web UI, terminals,
user and key management, or cluster management (join codes contain the cluster
secrets), whatever their level. The API Access page lists the endpoints per level.

**API terminals and shell commands** are for API keys only, and need explicit permissions
(Permission groups → Shell and Docker). The web terminal is unchanged: it always asks for
your own login and password and never uses a service account. When a Linux host is added,
Bosun can also create a second, non-admin *shell account* (default `bosun-user`) next to the
privileged service account. It has its own key, a locked password, no sudo and no
`docker`/`sudo`/`wheel`/`admin`/`lxd`/`disk` group, and sshd forbids port, agent and X11
forwarding for it. Bosun logs in as it before enabling it and checks again on every use;
if it is ever found to have admin rights, API access is refused.

- `POST /api/servers/:id/shell/exec` runs one command as that account (*Terminal and commands as the non-admin account*).
- `POST /api/servers/:id/terminal` returns a 60-second, single-use token for the WebSocket
  `/ws/api-terminal?token=…`. `{"target":"host"}` needs the same shell permission;
  `{"target":"container","container":"name"}` needs only *Open a shell in a container*, so
  a container shell can be granted without any host shell. A container shell is one fixed
  `docker exec` and ends with it; containers that could reach the host (privileged, host
  PID/IPC, Docker socket or sensitive host mounts, dangerous capabilities, devices) are refused.
- Neither path can reach the admin account: there is no admin shell, no fallback, and no
  stored admin key or password is ever handed to a session.
- **Windows hosts** get the same non-admin account (`bosun-user`): a standard local user with a random password nobody
  knows, a real profile holding its own key, hidden from the login screen, and no forwarding in `sshd_config`. Bosun logs
  in as it and checks that it is not an administrator, not elevated, cannot write to the Windows folder and cannot read the
  administrators' authorized keys before enabling it, and again on every use. The host target of an API terminal opens
  PowerShell as that account. Container shells are Linux-only.
- **Custom Command widget:** runs its one saved command as that non-admin account (never the service account), repeated at the
  interval set in the widget settings (10-3600 s). There is no box for typing commands; ad-hoc commands are an API feature.
- **Leftover keys:** when a host still has keys that look like an earlier Bosun's but are not labeled for it, Add Server
  lists them and lets you choose which to remove (none are pre-selected). Keys labeled exactly for the host are still replaced
  automatically, and every removal keeps a `.bosun-bak` backup and is undone if the new key would be lost.
- **Re-provision / rotate keys** (Settings → Servers, key button on each row): sets an already-added server up again from its  record, asking for the administrator login each time (never stored). Fresh keys are generated and proven to work, the  non-admin account is created or repaired, and with *Rotate keys* on the host's previous Bosun key is removed by its exact  key (even if labeled differently) and deleted from Bosun, so it can no longer log in. A server added with someone's own  key and login keeps that login untouched and gets a separate `bosun-svc` account. If a key may have leaked, also change the  host's administrator password and review its authorized_keys: only keys Bosun created are replaced.
- Limits are settings (Settings → Database): token lifetime (default 60 s, used once to open the
  WebSocket), maximum session length (60 min), idle timeout (10 min) and open terminals per API key (3).
  Values are clamped to sane ranges, so a bad value cannot switch a limit off.

**Widget packages with a declarative `spec`** (Settings → Widgets) render in Bosun without any code in the package:
a list, table or text view over data from a poller section or a command, plus actions with strictly validated
parameters. Each action names a permission the package declares and is also an API endpoint
(`POST /api/servers/:id/widget-actions/:widgetType/:actionId`); `GET /api/openapi.json` describes every installed
package's data and actions. Installing a package shows every command it can run and the account it runs as, and asks for
confirmation. The spec format is documented in `widgets/README.md`.

**Hiding servers and widgets.** A permission group can *deny* as well as allow. Denying *See a server* for a server
(or a server group) hides it from everyone in that group: it is not listed, its dashboards and widgets are gone and
every API route under it answers 404. Denying a package widget's data permission hides that widget. A deny beats any
allow, from any group or from the access level; Full access is never hidden anything. Every widget except the SSH Terminal is a package that is installed by default and can be
removed or upgraded under Settings → Widgets (see `widgets/README.md`); each tracks its own statistics and
keeps their history for the time its package declares.

**Email (SMTP)**, under Settings → General (admins), enables password reset links,
emailed sign-in codes and email alert actions. Set *App URL* to the address users open
Bosun at: reset links are built from it (or from `APP_URL`), never from the address a request came in on, so without
either no reset link is sent. The SMTP password is stored encrypted.

**Two-step verification** is optional per user: an authenticator app (TOTP) or codes
sent by email, plus ten single-use backup codes. Password reset needs SMTP; without it,
an admin resets the password from Settings → Users.

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

## Self-update

Settings → **Updates** keeps every node on the newest published image of a branch:

- **Images.** The repository's image workflow (`.github/workflows/image.yml`) builds every push to `main` and `dev` (the
  build runs the tests, lint and the production build) and publishes `ghcr.io/<owner>/bosun:<branch>` and
  `:sha-<commit>`. Pull requests are built but not published. The first time, make the package public on GitHub
  (your profile → Packages → bosun → Package settings → Change visibility), so nodes can pull it without a login.
- **What runs where.** Each image knows its commit and branch (`/api/health` → `version`). The cluster leader checks the
  registry every 6 hours and posts *Bosun update available* in the bell when a node runs something else.
- **Requirements.** Each node's Bosun stack must be a Bosun stack: import it first (*Importing stacks from Portainer*,
  on the same node or from another one), and each node must know its server (it finds it by itself, or set it under
  Settings → Wake-on-LAN). The page lists anything missing.
- **Update all nodes.** The database is backed up into the data volume (`backups/`, the last 3 are kept), then the nodes
  are updated one at a time: on its host the new image is pulled, tagged as the image the Bosun service runs (for
  example `bosun:latest`, so the compose file stays as it is) and that service is re-created. Bosun waits until the node
  answers on the new version and is back in the cluster before the next one; the node you started from goes last and
  reports the result in the bell when it is back. If a node does not come back within 10 minutes the update stops there.
## Upgrading and rolling back

- Back up first: Settings → Database → Export, or copy the `bosun-data` volume.
- The 2.0 schema is a fresh start (see *Schema management*); version 2 (Wake-on-LAN, custom
  widgets) and version 3 (second MAC, per-node WoL sender) upgrade earlier versions in place automatically. To roll back, run the
  previous image against the previous volume or backup. The old image cannot read
  a 2.0 database.
