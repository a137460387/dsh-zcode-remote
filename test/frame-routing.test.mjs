// Frame routing for concurrent tasks on ONE client.
//
// A link permits a single relay connection: a second connection kicks the first
// (`KICKED`). So when several tasks run on one client they share that socket, and
// their frames arrive interleaved. Each subscription's frames carry the
// `subscriptionId` its subscribe returned, and that id — not the socket — is what
// keeps task A's output out of task B's reply.
//
// These checks drive the real routing/absorbing code with synthetic frames, so no
// relay is needed.

import { ZcodeRemoteClient, ZcodeRemoteSession, sessionConfig } from '../lib/zcode-remote-client.js'

const assert = (label, ok) => {
  console.log(ok ? `PASS ${label}` : `FAIL ${label}`)
  if (!ok) process.exitCode = 1
}

/**
 * A session with a stubbed client that records listeners, so frames can be
 * delivered by hand exactly as the deskop would deliver them. `subId` is what
 * the desktop's subscribe ack carries: an id (default) or null for desktops
 * that return none.
 */
function harness(taskId = 'sess_active', subId) {
  const session = new ZcodeRemoteSession({ url: 'https://zcode.z.ai/remote/v4?sid=S&hash=H' })
  const listeners = []
  const sent = []
  const subscribed = []
  const unsubscribed = []
  let nextSub = 0
  const client = {
    listen: (channel, event, handler, arg) => {
      const entry = { channel, event, handler, arg }
      listeners.push(entry)
      return () => { entry.detached = true }
    },
    subscribeConversation: async (workspacePath, sessionId) => {
      subscribed.push({ workspacePath, sessionId })
      const subscriptionId = subId === undefined ? `sub-${++nextSub}` : subId
      return { ack: { subscriptionId } }
    },
    sendConversationCommand: async (workspacePath, envelope) => {
      sent.push(envelope)
      return { status: 'accepted', result: { type: 'inputAccepted' } }
    },
    // Same envelope shape the real client builds.
    makeCommand: (sessionId, type, payload) => ({
      commandId: `cmd-${sent.length + 1}`,
      clientId: 'client-test',
      sessionId,
      type,
      payload,
      issuedAt: 1,
    }),
    unsubscribeConversation: async (workspacePath, subscriptionId) => {
      unsubscribed.push({ workspacePath, subscriptionId })
      return { ok: true }
    },
  }
  session.ensureReady = async () => ({ client, bridge: { workspacePath: 'D:\\x' } })
  // The desktop's active task, which a dispatch with no explicit target uses.
  session.activeTaskId = taskId
  return { session, listeners, sent, subscribed, unsubscribed }
}

/** Deliver one conversation frame the way the desktop wraps it. */
function frame(subscriptionId, payload) {
  return { frame: { wireVersion: 3, kind: 'complete', topic: 'conversation/x', subscriptionId, frame: { payload } } }
}

const assistantRow = (rowId, text, state = 'complete') => ({ rowId, kind: 'assistantText', text, state })

// ---- Frames reach the dispatch that subscribed, and only that one ----
{
  const { session, listeners, subscribed, sent } = harness()
  // Two dispatches on ONE client: distinct tasks, distinct subscriptions.
  const a = await session.startDispatch({ text: 'task A' })
  const b = await session.startDispatch({ text: 'task B' })
  assert('both dispatches subscribed', subscribed.length === 2 && a.subscriptionId !== b.subscriptionId)
  assert('one listener serves both', listeners.length === 1)

  const deliver = listeners[0].handler
  // Interleave: A's frame, then B's, then A's completion.
  deliver(frame(a.subscriptionId, { kind: 'deltas', deltas: [{ rowId: 101, append: 'A says ' }] }))
  deliver(frame(b.subscriptionId, { kind: 'deltas', deltas: [{ rowId: 201, append: 'B says ' }] }))
  deliver(frame(a.subscriptionId, { kind: 'deltas', deltas: [{ rowId: 101, append: 'hello' }] }))
  deliver(frame(b.subscriptionId, { kind: 'deltas', deltas: [{ rowId: 201, append: 'world' }] }))

  assert('A accumulated only its own text', a.rows.get(101)?.text === 'A says hello')
  assert('B accumulated only its own text', b.rows.get(201)?.text === 'B says world')
  assert('A never received B\'s row', !a.rows.has(201))
  assert('B never received A\'s row', !b.rows.has(101))
  assert('A reports only its own reply', JSON.stringify(session.replyRows(a).map(r => r.text)) === '["A says hello"]')
  assert('B reports only its own reply', JSON.stringify(session.replyRows(b).map(r => r.text)) === '["B says world"]')
  assert('A targeted its own task', sent[0].sessionId === a.taskId && sent[1].sessionId === b.taskId)
}

// ---- A frame for an unknown subscription while several run is DROPPED ----
// Guessing would splice one task's output into another's reply; dropping fails
// visibly instead.
{
  const { session, listeners } = harness()
  const a = await session.startDispatch({ text: 'A' })
  const b = await session.startDispatch({ text: 'B' })
  const deliver = listeners[0].handler
  deliver(frame('sub-does-not-exist', { kind: 'deltas', deltas: [{ rowId: 999, append: 'stray' }] }))
  assert('a stray frame reaches neither task', !a.rows.has(999) && !b.rows.has(999))
}

// ---- With exactly one dispatch in flight, an unlabelled frame is unambiguous ----
{
  const { session, listeners } = harness()
  const only = await session.startDispatch({ text: 'only' })
  listeners[0].handler(frame(undefined, { kind: 'deltas', deltas: [{ rowId: 7, append: 'solo' }] }))
  assert('a single dispatch accepts an unlabelled frame', only.rows.get(7)?.text === 'solo')
}

// ---- A desktop that returns no subscriptionId: keys never collide ----
// With `session:<target>` as the fallback key, two dispatches into one task
// overwrote each other's routing and spliced their replies together.
{
  const { session, listeners, subscribed } = harness('sess_active', null)
  const a = await session.startDispatch({ text: 'first', sessionId: 'sess_same' })
  const b = await session.startDispatch({ text: 'second', sessionId: 'sess_same' })
  assert('both dispatches to one target hold separate routing entries',
    a.key !== b.key && session.dispatchHandlers.get(a.key) === a && session.dispatchHandlers.get(b.key) === b)
  assert('neither handle claims a subscription id', a.subscriptionId === null && b.subscriptionId === null)

  // Unlabelled frames reach only the single active dispatch; with two in
  // flight they are dropped rather than spliced into a guess.
  const deliver = listeners[0].handler
  deliver(frame(undefined, { kind: 'deltas', deltas: [{ rowId: 31, append: 'to-a' }] }))
  assert('a frame while two are active reaches neither handle', !a.rows.has(31) && !b.rows.has(31))
  a.settled = true
  session.dispatchHandlers.delete(b.key) // b leaves the picture
  deliver(frame(undefined, { kind: 'deltas', deltas: [{ rowId: 32, append: 'solo' }] }))
  assert('a frame once a alone remains lands on it', a.rows.get(32)?.text === 'solo')
  assert('both dispatches subscribed the same task', subscribed.every(s => s.sessionId === 'sess_same'))
}

// ---- A snapshot seeds rows; deltas append; before-rows are excluded ----
{
  const { session, listeners } = harness()
  const a = await session.startDispatch({ text: 'x' })
  const deliver = listeners[0].handler
  deliver(frame(a.subscriptionId, { kind: 'snapshot', snapshot: { rows: { window: [assistantRow(1, 'preexisting')] } } }))
  // Reading the reply uses `before`, captured after the initial snapshot settles.
  assert('a snapshot row is stored', a.rows.get(1)?.text === 'preexisting')
  deliver(frame(a.subscriptionId, { kind: 'deltas', deltas: [{ rowId: 2, append: 'the answer' }] }))
  assert('a delta row is appended', a.rows.get(2)?.text === 'the answer')
  // Rows present before this dispatch's prompt must not count as its reply.
  a.before = new Set([1])
  assert('a pre-prompt row is not a reply', session.replyRows(a).map(r => r.text).join() === 'the answer')
}

// ---- Only assistant text counts as a reply ----
{
  const { session, listeners } = harness()
  const a = await session.startDispatch({ text: 'x' })
  listeners[0].handler(frame(a.subscriptionId, {
    kind: 'snapshot',
    snapshot: { rows: { window: [
      { rowId: 1, kind: 'userText', text: 'the prompt', state: 'complete' },
      { rowId: 2, kind: 'assistantText', text: '   ', state: 'complete' },
      { rowId: 3, kind: 'assistantText', text: 'real', state: 'complete' },
      { rowId: 4, kind: 'toolCall', text: 'noise', state: 'complete' },
    ] } },
  }))
  assert('only non-blank assistant text is a reply', JSON.stringify(session.replyRows(a).map(r => r.text)) === '["real"]')
}

// ---- A SETTLED task releases its subscription, so a reused client does not accumulate ----
{
  const { session, listeners, unsubscribed } = harness()
  const a = await session.startDispatch({ text: 'x' })
  // Deliver a reply, then fake the silence the completion heuristic waits for.
  listeners[0].handler(frame(a.subscriptionId, { kind: 'deltas', deltas: [{ rowId: 1, append: 'done' }] }))
  a.lastChange = Date.now() - 20000
  await session.collectDispatch(a, { waitMs: 50 })
  assert('a settled collect unsubscribes that task', unsubscribed.length === 1
    && unsubscribed[0].subscriptionId === a.subscriptionId)
  assert('a settled collect drops the routing entry', !session.dispatchHandlers.has(a.key))
}

// ---- Re-subscribing moves the handler, so the refreshed stream still lands ----
{
  const { session, listeners } = harness()
  const a = await session.startDispatch({ text: 'x' })
  await session.resubscribe(a)
  assert('re-subscribe issues a new subscription id', a.subscriptionId === 'sub-2')
  assert('the old routing key is gone', !session.dispatchHandlers.has('sub-1'))
  assert('the new routing key is present', session.dispatchHandlers.get('sub-2') === a)
  // The desktop now streams under the new id; it must still reach this dispatch.
  listeners[0].handler(frame('sub-2', { kind: 'deltas', deltas: [{ rowId: 5, append: 'after resub' }] }))
  assert('frames under the new id reach the dispatch', a.rows.get(5)?.text === 'after resub')
}

// ---- createTask issues a createSession command and surfaces the new id ----
{
  const { session } = harness()
  const commands = []
  session.ensureReady = async () => ({
    client: {
      makeNewSessionCommand: (workspaceKey, text) => ({ type: 'createSession', sessionId: null, payload: { workspaceId: workspaceKey } }),
      sendConversationCommand: async (_ws, env) => {
        commands.push(env)
        return { status: 'accepted', result: { type: 'createSession', sessionId: 'sess_new' } }
      },
    },
    bridge: { workspacePath: 'D:\\x' },
    workspaceKey: 'D:\\x',
  })
  assert('createTask surfaces the new task id', await session.createTask() === 'sess_new')
  assert('createTask created with no first input', commands[0].type === 'createSession' && commands[0].payload.workspaceId === 'D:\\x')
}

// ---- startDispatch({newTask:true}) binds AND starts the task in one command ----
{
  const { session, listeners, subscribed, sent } = harness()
  const created = []
  const client = {
    listen: (channel, event, handler, arg) => { listeners.push({ channel, event, handler, arg }); return () => {} },
    subscribeConversation: async (workspacePath, sessionId) => {
      subscribed.push({ workspacePath, sessionId })
      return { ack: { subscriptionId: 'sub-newtask' } }
    },
    sendConversationCommand: async (_ws, env) => { created.push(env); sent.push(env); return { status: 'accepted', result: { type: 'createSession', sessionId: 'sess_newtask' } } },
    makeCommand: (sessionId, type, payload) => ({ commandId: 'cmd', clientId: 't', sessionId, type, payload, issuedAt: 1 }),
    makeNewSessionCommand: (workspaceKey, text) => ({ type: 'createSession', sessionId: null, payload: { workspaceId: workspaceKey, firstInput: { text } }, issuedAt: 1 }),
    unsubscribeConversation: async () => ({ ok: true }),
  }
  session.ensureReady = async () => ({ client, bridge: { workspacePath: 'D:\\x' }, workspaceKey: 'D:\\x' })
  const h = await session.startDispatch({ text: 'hello new task', newTask: true })
  assert('new-task dispatch targets the created session', h.taskId === 'sess_newtask')
  assert('the prompt rides the createSession command', created[0].type === 'createSession' && created[0].payload.firstInput.text === 'hello new task')
  assert('no separate sendText was issued', !created.some(e => e.type === 'sendText'))
  assert('the new session was subscribed', subscribed.some(s => s.sessionId === 'sess_newtask'))
  assert('a new task counts every row as its own output', h.before.size === 0)
}

// ---- The createSession envelope carries an explicit model selection ----
{
  const client = new ZcodeRemoteClient({ url: 'https://zcode.z.ai/remote/v4?sid=S&hash=H' })
  const configured = client.makeNewSessionCommand('D:\\x', 'go', {
    provider: 'builtin:zai-start-plan', model: 'GLM-5.3-Flash', thought: 'max',
  })
  assert('the config rides the createSession payload',
    configured.payload.config?.provider === 'builtin:zai-start-plan'
    && configured.payload.config?.model === 'GLM-5.3-Flash'
    && configured.payload.config?.thought === 'max')
  // firstInput.modelSelection stalls desktop 3.12.3 (task accepted, never starts,
  // zero rows — verified live), and firstInput.mode is dropped by its activation
  // path, so the first input must stay bare.
  assert('the first input stays bare',
    configured.payload.firstInput.text === 'go'
    && configured.payload.firstInput.modelSelection === undefined
    && configured.payload.firstInput.mode === undefined)
  const plain = client.makeNewSessionCommand('D:\\x', 'go')
  assert('no selection means no config key', plain.payload.config === undefined)
  const empty = client.makeNewSessionCommand('D:\\x')
  assert('an empty session carries neither input nor config',
    empty.payload.firstInput === undefined && empty.payload.config === undefined)
}

// ---- sessionConfig drops unspecified fields ----
{
  assert('a full selection is kept verbatim',
    JSON.stringify(sessionConfig({ provider: 'p', model: 'm', thought: 'max' }))
      === '{"provider":"p","model":"m","thought":"max"}')
  assert('unspecified fields are dropped', JSON.stringify(sessionConfig({ model: 'GLM-5.3' })) === '{"model":"GLM-5.3"}')
  assert('an empty selection is no config at all', sessionConfig({}) === undefined && sessionConfig() === undefined)
}

// ---- startDispatch forwards the model selection to the createSession command ----
{
  const { session } = harness()
  const created = []
  const client = {
    listen: () => () => {},
    subscribeConversation: async () => ({ ack: { subscriptionId: 'sub-cfg' } }),
    sendConversationCommand: async (_ws, env) => {
      created.push(env)
      return { status: 'accepted', result: { type: 'createSession', sessionId: 'sess_cfg' } }
    },
    makeCommand: (sessionId, type, payload) => ({ commandId: 'cmd', clientId: 't', sessionId, type, payload, issuedAt: 1 }),
    makeNewSessionCommand: (workspaceKey, text, config) => ({
      type: 'createSession', sessionId: null, issuedAt: 1,
      payload: {
        workspaceId: workspaceKey,
        ...(text !== undefined ? { firstInput: { text } } : {}),
        ...(config ? { config } : {}),
      },
    }),
    unsubscribeConversation: async () => ({ ok: true }),
  }
  session.ensureReady = async () => ({ client, bridge: { workspacePath: 'D:\\x' }, workspaceKey: 'D:\\x' })
  const h = await session.startDispatch({ text: 'think hard', newTask: true, model: 'GLM-5.3', thought: 'high' })
  assert('the selected model and level reach the command',
    created[0].payload.config?.model === 'GLM-5.3' && created[0].payload.config?.thought === 'high')
  assert('an unspecified provider stays out of the payload', created[0].payload.config?.provider === undefined)
  assert('the dispatch handle still targets the created task', h.taskId === 'sess_cfg')
}

// ---- The subscription snapshot's config is the authority on what applied ----
{
  const { session, listeners } = harness()
  const a = await session.startDispatch({ text: 'x' })
  listeners[0].handler(frame(a.subscriptionId, {
    kind: 'snapshot',
    snapshot: { rows: { window: [] }, config: { provider: 'builtin:zai-start-plan', model: 'GLM-5.3-Flash', thought: 'max' } },
  }))
  assert('the snapshot config is captured', a.effectiveConfig?.model === 'GLM-5.3-Flash' && a.effectiveConfig?.thought === 'max')
  listeners[0].handler(frame(a.subscriptionId, { kind: 'deltas', deltas: [{ rowId: 1, append: 'done' }] }))
  a.lastChange = Date.now() - 20000
  const result = await session.collectDispatch(a, { waitMs: 50 })
  assert('the collect result reports the effective config', result.config?.model === 'GLM-5.3-Flash' && result.complete === true)
  const b = await session.startDispatch({ text: 'y' })
  assert('a snapshot without config leaves it unset', b.effectiveConfig === undefined)
}
