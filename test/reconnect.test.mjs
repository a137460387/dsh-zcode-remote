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
