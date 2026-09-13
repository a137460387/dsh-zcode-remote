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

On top of that the plugin registers three dsh agent tools:

- **`zcode_remote_dispatch`** — send a prompt to a desktop task and collect the
  streamed assistant reply (completion = 12 s of frame silence, capped by
  `wait_seconds`, max 600 s).
- **`zcode_remote_status`** — list desktop workspaces and recent tasks.
- **`zcode_remote_stop`** — interrupt a running desktop task.

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
```

Run the tests with plain Node (no test runner needed):

```bash
node test/protocol.test.mjs
```

The package is installed into the profile as a `link:` dependency, so edits
under this directory take effect on the next profile (re)start.
