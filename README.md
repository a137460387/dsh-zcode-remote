# dsh-zcode-remote

Drive a **ZCode desktop agent** from **dsh (DeepSeek Harness)** through ZCode's
mobile remote-control relay — exactly the way the phone client does, packaged
as a dsh tool-plugin bundle.

## How it works

The plugin implements the full client stack of `https://zcode.z.ai/remote/v4`
(reverse-engineered from the official remote page bundle):

| Layer | Protocol |
| --- | --- |
| Relay WS | `wss://zcode.z.ai/ws?mid=…`, JSON envelopes; `auth_init` → `auth_challenge` → `auth_response` (HMAC-SHA256 proof `base64url(hmac(hash, "nonce\|terminal\|sid"))`) → `pair_status=matched` |
| App payloads | `{zcode_type: …}` inside `{type:'data'}`: `bootstrap-request`, `workspace-list-request`, `workspace-bridge-open` → `workspace-bridge-ready` |
| rpc-frame | logical messages fragmented into CRC32-checked base64 frames (`seq`/`messageSeq`/`fragmentIndex`/`fragmentCount`), acked with `rpc-frame-ack` |
| Channel RPC | VS Code style binary protocol (`[100,id,channel,method]+args`, `201/202/204` responses), varint-prefixed tagged values |
| Services | channel `zcode-agent`: `helloConversationV4`, `initializeConversationV4`, `subscribeConversationV4`, `sendConversationCommandV4`, `onDynamicConversationFrame` |

## Checking how many tasks are running

Each task in the `workspace-list-response` carries
`displayStatus: 'idle' | 'running' | 'completed' | 'error'`, where `running`
means the task is actively working. A ZCode client serves a bounded number of
concurrently working tasks, so `zcode_remote_status` reports the count:

```
Running tasks: 1 of 3 allowed (7 total)
```

`runningCount` is computed from the **complete** task list, not the 20-task view
the tool renders — a running task past that window would otherwise be missed and
a dispatch into an already-full client would go through. The list is re-fetched
at every status read and before every dispatch, so a long-lived pairing reports
current counts rather than a connect-time snapshot.

`zcode_remote_dispatch` checks the same count before sending: at the ceiling it
fails immediately with the count and points at `zcode_remote_stop`, instead of
queueing on the desktop and burning the whole wait budget.

The ceiling is configurable, because it is a desktop-side policy rather than a
wire-protocol constant:

```yaml
- id: zcode-remote
  config:
    maxRunningTasks: 3   # default
```


On top of that the plugin registers five dsh agent tools:

- **`zcode_remote_dispatch`** — send a prompt to a task on a ZCode client. By
  default waits for the reply (completion = 12 s of frame silence, capped by
  `wait_seconds`, max 600 s). With `async: true` returns as soon as the task is
  accepted; fetch the reply later with `zcode_remote_collect`. `new_task: true`
  creates a fresh task for the prompt instead of reusing a conversation — the
  prompt rides the createSession command's `firstInput.text` (the web page's
  "新建任务" path), because a relay-created session only binds to a desktop task
  when the first input rides creation; create-then-sendText fails with
  `FOREIGN KEY constraint failed`.
- **`zcode_remote_collect`** — fetch the reply of an async dispatch, by the same
  client and the `session_id` the dispatch returned. A task is released only once
  it has **completed** (a reply, then 12 s of silence); an unfinished one keeps
  its subscription, so calling collect again simply keeps waiting for it.
- **`zcode_remote_status`** — list one client's workspaces, recent tasks and
  running-task count.
- **`zcode_remote_devices`** — list the reachable clients, their configured
  names, the default, and which currently hold a pairing. Needs no connection.
- **`zcode_remote_stop`** — interrupt a running task on a client.

All client-scoped tools accept `device` or `url` to choose the client
(see [Reaching several machines](#reaching-several-machines)).

## Choosing a workspace

A workspace is one open project folder on the desktop. Every client tool accepts
an optional `workspace`, resolved against the client's open workspaces by exact
path, basename, or a unique trailing suffix — so "ZCodeProject" matches
`C:\Users\HUAWEI\ZCodeProject` and "dhsh" matches `D:\tools\dhsh` without the
full path.

If you name nothing, the call lands in the **default workspace**
(`config.defaultWorkspace`, which is `ZCodeProject` unless you set it in the
profile patch layer). If the default is not open on that client, the call fails
with the list of open workspaces instead of guessing.

```
zcode_remote_status(device:"hp")                        # workspaces + tasks
zcode_remote_status(device:"hp", workspace:"ZCodeProject")
zcode_remote_dispatch(device:"hp", workspace:"dhsh", text:"…")
```

One connection serves every workspace on a client: switching workspaces opens a
new bridge on the same socket, never a second connection. An ambiguous selector
(for example a basename that matches two open folders) fails loud rather than
picking one.

To pin the default for every call, set it in the profile patch layer:

```yaml
- id: zcode-remote
  config:
    defaultWorkspace: ZCodeProject
```

## Running several tasks on one client

Two hard constraints shape this, both verified against the client's own code:

1. **One link, one connection.** The relay admits exactly one terminal per link;
   a second connection kicks the first (`KICKED`). So this plugin holds ONE
   relay connection per client and multiplexes every task over it — it never
   opens a second socket for a second task. Keep the phone/browser page for a
   link closed while this plugin uses it, or the two will kick each other
   endlessly (both sides auto-reconnect).
2. **A client serves a bounded number of concurrent tasks** (`maxRunningTasks`,
   default 3). Concurrent tasks each get their own conversation (`new_task:
   true`) or an explicitly named `session_id`, and are told apart by the
   `subscriptionId` each `subscribeConversationV4` returns — that id, not the
   socket, separates one task's output from another's.

Fan out and gather:

```
# three tasks on one client, or spread over several — dispatches are
# concurrency-safe, so issue them together
zcode_remote_dispatch(device:"hw", text:"…", new_task:true, async:true)  → sessionId
zcode_remote_dispatch(device:"hp", text:"…", new_task:true, async:true)  → sessionId
zcode_remote_dispatch(device:"hw", text:"…", new_task:true, async:true)  → sessionId

zcode_remote_collect(device:"hw", session_id:"sess_…")   # each reply, when ready
zcode_remote_collect(device:"hp", session_id:"sess_…")
# a task that has not finished yet reports complete:false — collect it again
```

Each task completes **independently**: one finishing does not stop its siblings,
and collecting one does not touch the others. A task is complete once it has
produced a reply and then been silent for 12 s. `wait_seconds` is only a budget:
an unfinished task keeps its subscription, so a later `zcode_remote_collect`
picks up where the last one left off, instead of losing the stream mid-answer.

`dispatch` refuses at the ceiling with the observed count and points at
`zcode_remote_stop`, rather than queueing on the client and burning the wait
budget. Only a *completed* task releases its subscription, so a long-lived
pairing does not accumulate them, and an aborted collect never drops the shared
connection — the socket is held per client, so losing it would take down every
task on that client at once.

## Install

From any directory (this package declares `dsh.bundle`, so it joins the
profile layer stack automatically):

```bash
dsh plugin --profile headless add C:\path\to\dsh-zcode-remote
dsh plugin --profile headless update dsh-zcode-remote   # (re)activate the bundle layer
```

## Configure

Put your remote link (the URL the ZCode desktop app shows / the phone scans)
into the profile's user patch layer `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: zcode-remote
  config:
    remoteUrl: https://zcode.z.ai/remote/v4?sid=…&hash=…&t=…&mid=…&name=…
    # or: remoteSid / remoteHash / remoteMid
    # workspacePath: D:\some\repo        # pin a workspace instead of the active one
    # sessionId: sess_…                  # pin a task instead of the active one
    # waitSeconds: 180
```

The link is optional at boot: a profile starts cleanly without it and the tools
explain what to pass. That keeps the link out of the profile for setups that
prefer supplying it per call.

### Discover a ZCode desktop on the same Windows machine

When dsh and ZCode run on the same computer, the plugin can reconstruct the
remote-control URL from ZCode's local state instead of storing the URL or its
`hash` in the profile:

```yaml
- id: zcode-remote
  config:
    localDevice:
      home: C:\Users\luoguangyu
      username: luoguangyu
      label: local        # optional; default "local"
      name: My-PC         # optional; defaults to the host name
```

The plugin reads `telemetry-state.json` and `credentials.json` under
`<home>\.zcode\v2`, decrypts `pass_hash` with the same fallback secret as
ZCode, recovers the instance's current `sid` from its own log lines, and
creates a fresh URL timestamp on every resolution. It never writes the URL or
decrypted hash to disk. ZCode must still expose a currently active
remote-control pairing; local discovery cannot activate or renew that pairing
by itself.

**The sid is recovered from the instance's own log dir, not from the shared
setting.json.** ZCode's `settingService` writes the sid to the *real user
home's* setting.json (`~\.zcode\v2\setting.json`), ignoring a multi-open
slot's data dir — so several slots overwrite one another's sid in that file.
The instance's own `logs\*.log` carries its registrations (`external relay
auth saved {deviceSidSuffix}`) plus full-sid `session=d_…` lines, which is the
authoritative per-instance source. Pass `sharedSetting` to also try the shared
file as a fallback when logs carry nothing.

Set `home` and `username` explicitly when dsh runs as another account, such as
`NT AUTHORITY\SYSTEM`; the ZCode credential key is bound to the desktop user's
home and username, so `username` must name the ZCode process user. The
decryption key's home dir is derived automatically: for a slot data dir
`<user>\AppData\Roaming\zcode-multi\<N>\data` it resolves to `<user>`; override
with `secretHome` only when the ZCode user's home differs. If that ZCode
process was launched with `ZCODE_CREDENTIAL_SECRET`, local fallback discovery
cannot infer the secret; use a configured URL instead.

### Discover several same-machine instances (multi-open slots)

Each zcode-multi slot is an independent ZCode client (own account, mid, and
pass_hash) discoverable by a short name:

```yaml
- id: zcode-remote
  config:
    localDevices:
      s1: { home: C:\Users\luoguangyu\AppData\Roaming\zcode-multi\1\data, username: luoguangyu }
      s2: { home: C:\Users\luoguangyu\AppData\Roaming\zcode-multi\2\data, username: luoguangyu }
```

Address a slot with `device:"s1"` etc.; `zcode_remote_devices()` lists every
discovered instance. The default remains `localDevice` (or `device`/`remoteUrl`
when set).

The local device becomes the default only when `device`, `remoteUrl`, and the
split `remoteSid`/`remoteHash` form are absent. Address it explicitly by its
label when required:

```
zcode_remote_status(device:"local")
zcode_remote_dispatch(device:"s2", workspace:"dhsh", text:"…", new_task:true)
```

> Recovered URLs reflect the instance's *current* registration. When several
> slots are running, they re-register and rotate sids continuously (a
> "registration war" against the shared setting.json); always resolve the URL
> right before dispatching, and treat a `--verify`-style `waiting` result as
> "URL is valid but that desktop is offline", not a credential failure.

## Reaching several machines

A remote-control link identifies **one device pairing**, so a link selects
*which machine* to act on. Configure each machine once and address it by name:

```yaml
- id: zcode-remote
  config:
    device: laptop                       # what a call uses when it names nothing
    devices:
      laptop: https://zcode.z.ai/remote/v4?sid=…&hash=…&name=MateBook-X-Pro
      desktop: https://zcode.z.ai/remote/v4?sid=…&hash=…&name=WorkStation
      server:  https://zcode.z.ai/remote/v4?sid=…&hash=…&name=BuildBox
```

```
zcode_remote_devices()                                  # what can I reach?
zcode_remote_status(device: "server")                   # that machine's tasks
zcode_remote_dispatch(device: "desktop", text: "…")     # run work over there
zcode_remote_dispatch(url: "https://zcode.z.ai/…")      # a machine not in the map
```

Resolution order for which machine a call targets:

1. `device` — a configured name (fails loud if unknown, listing the known names)
2. `url` — a full link, for a machine not configured
3. `config.device` — the configured default
4. `config.remoteUrl` / `remoteSid`+`remoteHash` — the original single-device form

**Each client keeps its own live session.** Addressing one client never
disturbs another: switching desktop → server → desktop reuses the desktop's
existing pairing and subscription instead of re-pairing. Sessions are keyed by
the link's `sid` — which is also the relay's unit of "one terminal per link",
so one key = one admitted connection. Regenerating a link on a client issues a
NEW `sid` (verified live: two links from one client shared a `mid` but had
different `sid`s), and the stale entry is released when its connection fails.

Only a client whose own connection fails is released; the rest stay connected.
A `200 OK`-looking dispatch to the wrong client is impossible by construction:
a malformed `url` fails loud rather than falling back to the default client.

The original single-device configuration keeps working unchanged — `remoteUrl`
alone is simply a default device with no name.

## Notes & limits

- **One terminal per link**: the relay allows a single live terminal per
  session — having the phone page and this driver connected at the same time
  kicks one of them (`KICKED`). Each configured client counts separately, and
  one client's concurrent tasks share this plugin's single connection to it.
- **The running-task ceiling is per client**, not global: 3 slots on one client
  do not consume another's.
- **Model & reasoning level**: a new task inherits the desktop's workspace
  defaults unless specified. The Z.ai Start Plan channel (`builtin:zai-start-plan`)
  serves `GLM-5.3` and `GLM-5.3-Flash`, with reasoning levels `low | high | max`
  (`max` = 最高). The createSession envelope accepts
  `config: { provider, model, thought }` — the standalone driver
  (`remote-driver.mjs`, see the `.zcode-dsh` research dir) exposes this via
  `--model/--thought/--provider`; this plugin does not yet expose it as a tool
  parameter. Invalid values are **silently** replaced by desktop defaults, so
  verify via the subscription snapshot's `config` field — agent self-reports are
  unreliable (a GLM-5.3-Flash agent reported `THOUGHT=high` while the snapshot
  showed `max`).
- **Links are longer-lived than first measured**: the original 10-min TTL
  estimate came from a revoked test link. A freshly generated link stayed
  working for 45+ minutes of continuous dispatching. Still treat links as
  per-session material — regenerate when a pairing is refused.
- **Desktop must be alive**: if the desktop's window host is down you get
  `workspace-bridge-error(desktop-disconnected): 未找到桌面窗口 host process`.
- The link carries a secret (`hash`); treat the config file accordingly.
- Live-verified end-to-end against a real desktop (HP, `D:\tools\dhsh` and
  `C:\Users\luoguangyu\ZCodeProject`): pairing, bootstrap, workspace list,
  bridge open, hello/initialize, subscribe, createSession+firstInput
  (with model/thought config), conversationRowsRangeV4 polling, reply
  read-back, and the `onDynamicConversationFrame` state snapshot. The frame
  routing, async dispatch and collect paths are unit-tested against synthetic
  frames.

## Development

```
lib/zcode-remote-client.js        protocol driver (no dependencies, plain ESM)
lib/local-zcode-credentials.js    same-machine ZCode credential discovery
lib/index.js                      cordis plugin: Config + 5 tools, client routing
cordis.patch.yml                  bundle layer: inserts the plugin entry
test/local-credentials.test.mjs   local credential reconstruction and identity failures
test/protocol.test.mjs            wire codec: CRC32, framing, assembly
test/device-addressing.test.mjs   target resolution and the tool surface
test/session-cache.test.mjs       per-client session isolation
test/running-tasks.test.mjs       running-task counting and the capacity guard
test/frame-routing.test.mjs       concurrent-task frame demultiplexing + new-task (firstInput) path
test/task-independence.test.mjs   per-task completion and reusable collect
test/workspace-selection.test.mjs workspace matching and the ZCodeProject default
```

Run the tests with plain Node (no test runner needed):

```bash
for f in test/*.test.mjs; do node "$f"; done
```

The package is installed into the profile as a `link:` dependency, so this
directory IS the loaded source — no build or copy step. Note the two different
reload behaviours:

- **`cordis.patch.yml` config edits** (including the remote link): live for a
  `patchReload: live` profile such as `web`, restart-only for `startup`
  profiles such as `headless`.
- **`lib/*.js` code edits**: take effect only on the next process start. The
  loader imports the module once and Node's ESM cache returns that same module
  on any later reload, so a patch-file reload does not pick up code changes.
  Verify a code change is live by checking the registered tool schemas — a new
  parameter appears in `parameters.properties` only after a restart.
