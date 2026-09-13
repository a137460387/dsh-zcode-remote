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
a dispatch into an already-full client would go through.

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


On top of that the plugin registers four dsh agent tools:

- **`zcode_remote_dispatch`** — send a prompt to a desktop task and collect the
  streamed assistant reply (completion = 12 s of frame silence, capped by
  `wait_seconds`, max 600 s).
- **`zcode_remote_status`** — list one device's workspaces, recent tasks and
  running-task count.
- **`zcode_remote_devices`** — list the reachable devices, their configured
  names, the default, and which currently hold a pairing. Needs no connection.
- **`zcode_remote_stop`** — interrupt a running desktop task.

All three device-scoped tools accept `device` or `url` to choose the machine
(see [Reaching several machines](#reaching-several-machines)).

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

**Each machine keeps its own live session.** Addressing one device never
disturbs another: switching desktop → server → desktop reuses the desktop's
existing pairing and subscription instead of re-pairing. Pairings are keyed by
the link's `sid`, so a re-issued link for the same pairing (new `hash` and `t`,
same `sid`) replaces that session while leaving other machines alone.

Only a machine whose own connection fails is released; the rest stay connected.
A `200 OK`-looking dispatch to the wrong machine is impossible by construction:
a malformed `url` fails loud rather than falling back to the default device.

The original single-device configuration keeps working unchanged — `remoteUrl`
alone is simply a default device with no name.

## Notes & limits

- **One terminal per link**: the relay allows a single live terminal per
  session — having the phone page and this driver connected at the same time
  kicks one of them (`KICKED`). Each configured machine counts separately.
- **The running-task ceiling is per machine**, not global: 3 slots on one device
  do not consume another's.
- **Desktop must be alive**: if the desktop's window host is down you get
  `workspace-bridge-error(desktop-disconnected): 未找到桌面窗口 host process`.
- The link carries a secret (`hash`); treat the config file accordingly.
- Known-verified live: pairing, bootstrap, workspace list, bridge open,
  hello/initialize RPC. Subscribe + sendText follow the official page code
  path 1:1 but were blocked in final live testing by the desktop host being
  offline.

## Development

```
lib/zcode-remote-client.js        protocol driver (no dependencies, plain ESM)
lib/index.js                      cordis plugin: Config + 4 tools, device routing
cordis.patch.yml                  bundle layer: inserts the plugin entry
test/protocol.test.mjs            wire codec: CRC32, framing, assembly
test/device-addressing.test.mjs   target resolution and the tool surface
test/session-cache.test.mjs       per-device session isolation
test/running-tasks.test.mjs       running-task counting and the capacity guard
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
