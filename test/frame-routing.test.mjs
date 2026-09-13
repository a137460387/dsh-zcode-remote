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

import { ZcodeRemoteSession } from '../lib/zcode-remote-client.js'

const assert = (label, ok) => {
  console.log(ok ? `PASS ${label}` : `FAIL ${label}`)
  if (!ok) process.exitCode = 1
}

/**
 * A session with a stubbed client that records listeners, so frames can be
 * delivered by hand exactly as the deskop would deliver them.
 */
function harness(taskId = 'sess_active') {
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
      const subscriptionId = `sub-${++nextSub}`
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

// ---- Collecting releases the subscription, so a reused client does not accumulate ----
{
  const { session, unsubscribed } = harness()
  const a = await session.startDispatch({ text: 'x' })
  await session.collectDispatch(a, { waitMs: 1 })
  assert('collecting unsubscribes that task', unsubscribed.length === 1
    && unsubscribed[0].subscriptionId === a.subscriptionId)
  assert('collecting drops the routing entry', !session.dispatchHandlers.has(a.key))
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

// ---- createTask returns the desktop's new task id ----
{
  const { session } = harness()
  session.ensureReady = async () => ({
    client: { createTask: async () => ({ sessionId: 'sess_new', raw: {} }) },
    bridge: { workspacePath: 'D:\\x' },
  })
  assert('createTask surfaces the new task id', await session.createTask() === 'sess_new')
}
