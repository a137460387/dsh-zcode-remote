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


On top of that the plugin registers three dsh agent tools:

- **`zcode_remote_dispatch`** — send a prompt to a desktop task and collect the
  streamed assistant reply (completion = 12 s of frame silence, capped by
  `wait_seconds`, max 600 s).
- **`zcode_remote_status`** — list desktop workspaces and recent tasks.
- **`zcode_remote_stop`** — interrupt a running desktop task.

All three accept an optional `url` to replace an expired remote link at call
time (see [Configure](#configure)).

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

### Replacing an expired link without editing the profile

The desktop link carries a timestamp and expires. Every tool accepts an optional
`url`, so an expired link is replaced in-conversation:

```
zcode_remote_status(url: "https://zcode.z.ai/remote/v4?sid=…&hash=…&t=…&mid=…")
```

The override wins for that call and every later call. Passing a different link
retires the previous session (closing its socket) and pairs with the new one, so
no profile restart is needed.

A malformed `url` (one without `sid=`) fails loud rather than silently falling
back to the configured link, which could still be the expired one you were
trying to replace.

When a pairing or bridge failure occurs, the session is released: the next call
reconnects from scratch instead of replaying a dead socket.

## Notes & limits

- **One terminal per link**: the relay allows a single live terminal per
  session — having the phone page and this driver connected at the same time
  kicks one of them (`KICKED`).
- **Desktop must be alive**: if the desktop's window host is down you get
  `workspace-bridge-error(desktop-disconnected): 未找到桌面窗口 host process`.
- The link carries a secret (`hash`); treat the config file accordingly.
- Known-verified live: pairing, bootstrap, workspace list, bridge open,
  hello/initialize RPC. Subscribe + sendText follow the official page code
  path 1:1 but were blocked in final live testing by the desktop host being
  offline.

## Development

```
lib/zcode-remote-client.js   protocol driver (no dependencies, plain ESM)
lib/index.js                 cordis plugin: Config + 3 tools
cordis.patch.yml             bundle layer: inserts the plugin entry
test/protocol.test.mjs       wire codec: CRC32, framing, assembly
test/url-override.test.mjs   link resolution and the tool surface
test/running-tasks.test.mjs  running-task counting and the capacity guard
```

Run the tests with plain Node (no test runner needed):

```bash
node test/protocol.test.mjs
node test/url-override.test.mjs
node test/running-tasks.test.mjs
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
