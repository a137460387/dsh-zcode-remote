// Task independence on one shared connection.
//
// The orchestration this plugin exists for: several tasks run concurrently on ONE
// client (the relay admits a single connection per link, so they multiplex), and
// the orchestrator collects each as it finishes. The failure mode being guarded
// against: one task finishing — or one collect timing out — disturbing the tasks
// still running on that same client.
//
// Driven with synthetic frames and a stubbed client, so no relay is needed.
//
// "Settled" below means a task has produced a reply AND been silent long enough
// for the completion heuristic (12 s). Tests fake that silence by backdating
// `lastChange`, because the real 12 s is wall-clock and untestable.

import { ZcodeRemoteSession } from '../lib/zcode-remote-client.js'

const assert = (label, ok) => {
  console.log(ok ? `PASS ${label}` : `FAIL ${label}`)
  if (!ok) process.exitCode = 1
}

function harness() {
  const session = new ZcodeRemoteSession({ url: 'https://zcode.z.ai/remote/v4?sid=S&hash=H' })
  const listeners = []
  const unsubscribed = []
  let nextSub = 0
  const client = {
    listen: (channel, event, handler, arg) => {
      listeners.push({ channel, event, handler, arg })
      return () => {}
    },
    subscribeConversation: async () => ({ ack: { subscriptionId: `sub-${++nextSub}` } }),
    sendConversationCommand: async () => ({ status: 'accepted', result: { type: 'inputAccepted' } }),
    unsubscribeConversation: async (workspacePath, subscriptionId) => {
      unsubscribed.push(subscriptionId)
      return { ok: true }
    },
    makeCommand: (sessionId, type, payload) => ({ commandId: `c-${sessionId}`, clientId: 't', sessionId, type, payload, issuedAt: 1 }),
  }
  session.ensureReady = async () => ({ client, bridge: { workspacePath: 'D:\\x' } })
  session.activeTaskId = 'sess_active'
  return { session, listeners, unsubscribed }
}

const frame = (subscriptionId, payload) =>
  ({ frame: { wireVersion: 3, kind: 'complete', topic: 'conversation/x', subscriptionId, frame: { payload } } })
const answer = (rowId, text) => ({ kind: 'deltas', deltas: [{ rowId, append: text }] })
// Mark a handle as "has been silent for a while", the way the desktop's quiet
// period looks to the completion heuristic.
const settle = (handle) => { handle.lastChange = Date.now() - 20000 }

// ---- The user's scenario: three tasks on one client; one finishes first ----
{
  const { session, listeners, unsubscribed } = harness()
  const a = await session.startDispatch({ text: 'A', sessionId: 'sess_a' })
  const b = await session.startDispatch({ text: 'B', sessionId: 'sess_b' })
  const c = await session.startDispatch({ text: 'C', sessionId: 'sess_c' })
  const fire = listeners[0].handler

  // All three stream; A finishes first and goes quiet.
  fire(frame(a.subscriptionId, answer(1, 'answer A')))
  fire(frame(b.subscriptionId, answer(2, 'answer B (partial…)')))
  fire(frame(c.subscriptionId, answer(3, 'answer C (partial…)')))
  settle(a)

  const ra = await session.collectDispatch(a, { waitMs: 50 })
  assert('the finished task reports complete', ra.complete === true && ra.replies.join() === 'answer A')
  assert('only the finished task unsubscribed', unsubscribed.length === 1 && unsubscribed[0] === a.subscriptionId)
  assert('the other tasks keep their routing entries',
    session.dispatchHandlers.has(b.key) && session.dispatchHandlers.has(c.key))
  assert('the finished task loses its routing entry', !session.dispatchHandlers.has(a.key))

  // B and C keep streaming AFTER A was collected.
  fire(frame(b.subscriptionId, answer(2, ' …more')))
  fire(frame(c.subscriptionId, answer(3, ' …more')))
  assert('B still accumulates after A finished', b.rows.get(2)?.text === 'answer B (partial…) …more')
  assert('C still accumulates after A finished', c.rows.get(3)?.text === 'answer C (partial…) …more')
  assert('B is still a pending reply', session.replyRows(b).map(r => r.text).join().includes('answer B'))
}

// ---- An unfinished collect can simply be called again ----
{
  const { session, listeners, unsubscribed } = harness()
  const a = await session.startDispatch({ text: 'A', sessionId: 'sess_a' })
  const fire = listeners[0].handler
  fire(frame(a.subscriptionId, answer(1, 'partial')))
  // First collect runs out of budget while the task is still talking (no quiet).
  const first = await session.collectDispatch(a, { waitMs: 1 })
  assert('an exhausted collect keeps the subscription', unsubscribed.length === 0)
  assert('the task stays routable', session.dispatchHandlers.has(a.key))
  assert('an exhausted collect reports incomplete', first.complete === false)
  assert('an exhausted collect still shows partial text', first.replies.join() === 'partial')

  // The task keeps streaming; a later collect sees the full answer and settles.
  fire(frame(a.subscriptionId, answer(2, ' finished')))
  settle(a)
  const second = await session.collectDispatch(a, { waitMs: 50 })
  assert('a second collect sees the later reply',
    JSON.stringify(second.replies) === '["partial"," finished"]')
  assert('a second collect reports complete', second.complete === true)
  assert('completion releases the subscription', unsubscribed.length === 1)
  assert('the routing entry is gone once complete', !session.dispatchHandlers.has(a.key))
}

// ---- replyRows covers rows from every collect window, in order ----
{
  const { session, listeners } = harness()
  const a = await session.startDispatch({ text: 'A', sessionId: 'sess_a' })
  const fire = listeners[0].handler
  fire(frame(a.subscriptionId, answer(1, 'part 1')))
  await session.collectDispatch(a, { waitMs: 1 })
  fire(frame(a.subscriptionId, answer(2, 'part 2')))
  const r = await session.collectDispatch(a, { waitMs: 1 })
  assert('answers from both windows are reported', JSON.stringify(r.replies) === '["part 1","part 2"]')
}

// ---- A task from before a restart can be re-attached without sending ----
{
  const session = new ZcodeRemoteSession({ url: 'https://zcode.z.ai/remote/v4?sid=S&hash=H' })
  const listeners = []
  const commands = []
  const unsubscribed = []
  let nextSub = 0
  const client = {
    listen: (channel, event, handler) => { listeners.push(handler); return () => {} },
    subscribeConversation: async () => ({ ack: { subscriptionId: `sub-${++nextSub}` } }),
    sendConversationCommand: async (_ws, env) => { commands.push(env); return { status: 'accepted', result: { type: 'inputAccepted' } } },
    unsubscribeConversation: async (_ws, subscriptionId) => { unsubscribed.push(subscriptionId); return { ok: true } },
  }
  session.ensureReady = async () => ({ client, bridge: { workspacePath: 'D:\\x' }, workspaceKey: 'D:\\x' })

  const handle = await session.reattachDispatch('sess_re', 'D:\\x')
  assert('reattach subscribes without sending a message', commands.length === 0 && Boolean(handle.subscriptionId))
  assert('reattach counts every row as the task\'s own output', handle.before.size === 0)
  assert('reattach is routable', session.dispatchHandlers.get(handle.key) === handle)

  // The subscription snapshot replays the conversation the desktop kept; the
  // task's reply from before the restart is in it.
  listeners[0](frame(handle.subscriptionId, {
    kind: 'snapshot',
    snapshot: { rows: { window: [
      { rowId: 1, kind: 'userText', text: 'the original prompt', state: 'complete' },
      { rowId: 2, kind: 'assistantText', text: 'the pre-restart reply', state: 'complete' },
    ] } },
  }))
  settle(handle)
  const result = await session.collectDispatch(handle, { waitMs: 50 })
  assert('collect after reattach reports the pre-restart reply',
    result.complete === true && JSON.stringify(result.replies) === '["the pre-restart reply"]')
  assert('a completed reattach releases the subscription', unsubscribed.length === 1 && !session.dispatchHandlers.has(handle.key))
}
