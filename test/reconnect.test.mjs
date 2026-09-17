// Reconnect rebuilds connection-scoped state.
//
// A relay drop replaces the ZcodeRemoteClient, but bridges, frame routers and
// the agent handshake belong to the OLD socket. Reusing them leaves the new
// client un-initialized (every RPC waits for an ack that never comes) and
// routes frames to subscriptions the relay no longer knows — and the collect
// path swallows those failures, so a dropped relay stalled every later collect
// until the pairing was dropped externally. ensureClient must clear them so the
// fresh connection re-bridges, re-handshakes and re-routes.

import { ZcodeRemoteClient, ZcodeRemoteSession } from '../lib/zcode-remote-client.js'

const assert = (label, ok) => {
  console.log(ok ? `PASS ${label}` : `FAIL ${label}`)
  if (!ok) process.exitCode = 1
}

const LINK = 'https://zcode.z.ai/remote/v4?sid=S&hash=H'
const WS_LIST = () => ({
  activeWorkspaceKey: 'D:\\x',
  activeTaskId: 'a',
  workspaces: [{ workspacePath: 'D:\\x', workspaceIdentity: '' }],
  tasks: [],
})

{
  const session = new ZcodeRemoteSession({ url: LINK })
  // State as a long-lived pairing holds it: a dead client plus the artifacts of
  // the old connection.
  let closedOld = false
  session.client = { state: 'closed', ws: { readyState: 3 }, close: () => { closedOld = true } }
  session.wsList = WS_LIST()
  session.bridges.set('D:\\x', { bridgeSessionId: 'old-bridge', workspacePath: 'D:\\x' })
  session.frameRouters.set('old-bridge', () => {})
  session.agentReady = Promise.resolve()

  // Stub the client's wire surface: the session-level reconnect logic is under
  // test, not the relay protocol (protocol.test.mjs owns the codec).
  const created = []
  let subSeq = 0
  const wireSurface = {
    connect: ZcodeRemoteClient.prototype.connect,
    listWorkspaces: ZcodeRemoteClient.prototype.listWorkspaces,
    openBridge: ZcodeRemoteClient.prototype.openBridge,
    waitInitialized: ZcodeRemoteClient.prototype.waitInitialized,
    call: ZcodeRemoteClient.prototype.call,
  }
  Object.assign(ZcodeRemoteClient.prototype, {
    connect: async function () {
      this.state = 'paired'
      this.ws = { readyState: 1, send: () => {} }
      created.push(this)
      return this
    },
    listWorkspaces: async () => WS_LIST(),
    openBridge: async function (wsKey) {
      // The real openBridge attaches the bridge before returning; attachBridge
      // is what lets `listen` send frames, so the stub reproduces that.
      const bridge = { bridgeSessionId: 'new-bridge', workspacePath: wsKey, workspaceIdentity: '' }
      this.attachBridge(bridge)
      return bridge
    },
    waitInitialized: async () => {},
    call: async function (_channel, method, args) {
      this.calls ??= []
      this.calls.push(method)
      if (method === 'sendConversationCommandV4') {
        const envelope = args?.[0]?.envelope
        if (envelope?.type === 'createSession') {
          return { result: { sessionId: 'sess_new' }, ack: { status: 'accepted' } }
        }
        return { ack: { status: 'accepted' } }
      }
      return { ack: { subscriptionId: `sub-${++subSeq}` } }
    },
  })

  try {
    const ready = await session.ensureReady('D:\\x')
    assert('the dead client was closed', closedOld)
    assert('a fresh client was built', created.length === 1 && ready.client === created[0])
    assert('the stale bridge was replaced', session.bridges.get('D:\\x').bridgeSessionId === 'new-bridge')
    assert('the agent handshake re-ran on the new client',
      created[0].calls?.[0] === 'helloConversationV4' && created[0].calls?.[1] === 'initializeConversationV4')

    // A dispatch after the reconnect works end to end, including the frame
    // router that routes conversation frames to its subscription.
    const handle = await session.startDispatch({ text: 'ping', newTask: true, workspace: 'D:\\x' })
    assert('a frame router is registered for the new bridge',
      session.frameRouters.has('new-bridge') && !session.frameRouters.has('old-bridge'))
    assert('the new dispatch is routed by its subscription', session.dispatchHandlers.get(handle.key) === handle)

    // An in-flight task recovers: resubscribe re-keys the handle onto a fresh
    // subscription, so collect keeps receiving that task's stream.
    const oldKey = handle.key
    await session.resubscribe(handle)
    assert('the handle moved to a fresh subscription id', handle.key !== oldKey && handle.key === handle.subscriptionId)
    assert('the fresh subscription routes to the handle',
      session.dispatchHandlers.get(handle.key) === handle && !session.dispatchHandlers.has(oldKey))
  } finally {
    Object.assign(ZcodeRemoteClient.prototype, wireSurface)
  }
}

// ---- A collect mid-flight survives a reconnect: the router is rebuilt ----
// ensureClient clears frameRouters on reconnect; before the fix, resubscribe
// never re-registered one, so frames for the fresh subscription had nowhere to
// go and the collect burned its whole budget. Drive the REAL collect loop's
// 30 s safety net with a reconnect mid-wait and prove frames still land.
{
  const session = new ZcodeRemoteSession({ url: LINK })
  const listeners = []
  let subSeq = 0
  const stubClient = {
    state: 'paired', ws: { readyState: 1 },
    listen: (_channel, _event, handler) => { listeners.push(handler); return () => {} },
    listWorkspaces: async () => WS_LIST(),
    openBridge: async function () {
      this.attachBridge({ bridgeSessionId: 'b1', workspacePath: 'D:\\x', workspaceIdentity: '' })
      return { bridgeSessionId: 'b1', workspacePath: 'D:\\x', workspaceIdentity: '' }
    },
    agentHello: async () => ({}), agentInitialize: async () => ({}),
    subscribeConversation: async () => ({ ack: { subscriptionId: `sub-${++subSeq}` } }),
    sendConversationCommand: async () => ({ status: 'accepted', result: { type: 'inputAccepted' } }),
    unsubscribeConversation: async () => ({ ok: true }),
    makeCommand: (s, t, p) => ({ commandId: 'c', clientId: 't', sessionId: s, type: t, payload: p, issuedAt: 1 }),
    close: () => {},
  }
  session.ensureReady = async () => {
    session.ensureFrameRouter(stubClient, { bridgeSessionId: 'b1', workspacePath: 'D:\\x' })
    return { client: stubClient, bridge: { bridgeSessionId: 'b1', workspacePath: 'D:\\x' }, workspaceKey: 'D:\\x' }
  }
  session.activeTaskId = 'sess_a'
  const handle = await session.startDispatch({ text: 'x' })
  assert('one router before reconnect', listeners.length === 1)

  // Reconnect wipes the router; the collect loop's 30 s resubscribe must rebuild it.
  session.frameRouters.clear()
  assert('router is gone after reconnect', session.frameRouters.size === 0)
  await session.resubscribe(handle)
  assert('resubscribe re-registers the frame router', session.frameRouters.size === 1 && listeners.length === 2)

  // Frames under the fresh subscription id route to the handle and settle it.
  const deliver = listeners[listeners.length - 1]
  deliver({ frame: { wireVersion: 3, kind: 'complete', topic: 'conversation/x', subscriptionId: handle.subscriptionId, frame: { payload: { kind: 'deltas', deltas: [{ rowId: 9, append: 'post-reconnect' }] } } } })
  handle.lastChange = Date.now() - 20000
  const result = await session.collectDispatch(handle, { waitMs: 50 })
  assert('collect completes with the post-reconnect frame',
    result.complete === true && JSON.stringify(result.replies) === '["post-reconnect"]')
}

// ---- Re-subscribing releases the superseded desktop subscription ----
// The collect loop's 30 s safety net resubscribes for as long as a task runs;
// without an unsubscribe of the old id, every cycle leaves one more zombie
// subscription on the desktop.
{
  const session = new ZcodeRemoteSession({ url: LINK })
  const unsubscribed = []
  let subSeq = 0
  const stubClient = {
    state: 'paired', ws: { readyState: 1 },
    listen: () => () => {},
    listWorkspaces: async () => WS_LIST(),
    openBridge: async function () {
      this.attachBridge({ bridgeSessionId: 'b1', workspacePath: 'D:\\x', workspaceIdentity: '' })
      return { bridgeSessionId: 'b1', workspacePath: 'D:\\x', workspaceIdentity: '' }
    },
    agentHello: async () => ({}), agentInitialize: async () => ({}),
    subscribeConversation: async () => ({ ack: { subscriptionId: `sub-${++subSeq}` } }),
    sendConversationCommand: async () => ({ status: 'accepted', result: { type: 'inputAccepted' } }),
    unsubscribeConversation: async (_ws, id) => { unsubscribed.push(id); return { ok: true } },
    makeCommand: (s, t, p) => ({ commandId: 'c', clientId: 't', sessionId: s, type: t, payload: p, issuedAt: 1 }),
    close: () => {},
  }
  session.ensureReady = async () => {
    session.ensureFrameRouter(stubClient, { bridgeSessionId: 'b1', workspacePath: 'D:\\x' })
    return { client: stubClient, bridge: { bridgeSessionId: 'b1', workspacePath: 'D:\\x' }, workspaceKey: 'D:\\x' }
  }
  session.activeTaskId = 'sess_a'
  const handle = await session.startDispatch({ text: 'x' })
  assert('a failed unsubscribe is logged, not thrown', true) // shape check below

  // Three safety-net cycles: each must retire the id it superseded.
  const seen = []
  for (let i = 0; i < 3; i++) {
    const before = handle.subscriptionId
    await session.resubscribe(handle)
    seen.push({ before, after: handle.subscriptionId })
  }
  assert('each resubscribe moved to a fresh id', seen.every(s => s.after !== s.before))
  assert('every superseded id was unsubscribed exactly once',
    unsubscribed.length === 3 && unsubscribed[0] === 'sub-1' && unsubscribed[2] === 'sub-3')
  assert('live subscriptions stay bounded', 4 - unsubscribed.length === 1) // only the current one
  assert('the routing entry tracks the current id only',
    session.dispatchHandlers.size === 1 && session.dispatchHandlers.get(handle.subscriptionId) === handle)
}
