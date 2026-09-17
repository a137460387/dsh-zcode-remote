// Running-task counting and the dispatch capacity guard.
//
// The desktop reports one `displayStatus` per task; `running` means that task is
// actively working. A ZCode client allows a bounded number of concurrently
// working tasks, so the count must come from the COMPLETE task list — counting a
// truncated view would under-report and let a dispatch into a full client
// through.
//
// ZcodeRemoteSession is exercised against a stubbed client: no relay is needed
// to verify how tasks are counted.

import { ZcodeRemoteSession } from '../lib/zcode-remote-client.js'
import { capacityRefusal } from '../lib/index.js'

const assert = (label, ok) => {
  console.log(ok ? `PASS ${label}` : `FAIL ${label}`)
  if (!ok) process.exitCode = 1
}

/** A session whose client is stubbed, bypassing connect(). */
function stubSession(tasks, { workspaces = [] } = {}) {
  const session = new ZcodeRemoteSession({ url: 'https://zcode.z.ai/remote/v4?sid=S&hash=H' })
  const wsList = { activeWorkspaceKey: 'ws', activeTaskId: 't-active', workspaces, tasks }
  const client = {
    listWorkspaces: async () => wsList,
  }
  // taskList/runningTaskCount/listStatus go through ensureClient + wsList;
  // bridge-scoped calls go through ensureReady. Stub both layers.
  session.ensureClient = async () => client
  session.wsList = wsList
  session.ensureReady = async () => ({ client, bridge: { workspacePath: 'D:\\x' } })
  return session
}

const task = (taskId, displayStatus) => ({ taskId, title: taskId, displayStatus, workspacePath: 'D:\\x', updatedAt: 1 })

// Counting itself.
const mixed = [task('t1', 'running'), task('t2', 'idle'), task('t3', 'running'), task('t4', 'completed')]
assert('counts only running tasks', await stubSession(mixed).runningTaskCount() === 2)
assert('counts zero when nothing runs', await stubSession([task('t1', 'idle'), task('t2', 'completed')]).runningTaskCount() === 0)
assert('handles an empty task list', await stubSession([]).runningTaskCount() === 0)
assert('treats a missing displayStatus as not running', await stubSession([{ taskId: 't1', title: 'x' }]).runningTaskCount() === 0)

// A task past the display window must still be counted: the count is taken from
// the full list, while the rendered view shows only the first 20.
const many = Array.from({ length: 30 }, (_, i) => task(`t${i}`, 'idle'))
many[25].displayStatus = 'running'
const status = await stubSession(many).listStatus()
assert('counts running tasks outside the displayed window', status.runningCount === 1)
assert('still reports the total', status.totalCount === 30)
assert('displayed view stays truncated', status.tasks.length === 20)
assert('reports which tasks are running', JSON.stringify(status.runningTaskIds) === '["t25"]')

// Full and over-full clients must both be detectable by the guard's comparison.
const full = await stubSession([task('a', 'running'), task('b', 'running'), task('c', 'running')]).runningTaskCount()
assert('reports a full client as 3', full === 3)
const over = await stubSession(Array.from({ length: 5 }, (_, i) => task(`t${i}`, 'running'))).runningTaskCount()
assert('reports a count above the limit when it exceeds it', over === 5 && over > 3)

// The snapshot is re-fetched on every read: a pairing outlives one status call,
// so a connect-time list would freeze the count while tasks start and finish
// elsewhere on the desktop.
{
  const session = new ZcodeRemoteSession({ url: 'https://zcode.z.ai/remote/v4?sid=S&hash=H' })
  const tasks = [task('t1', 'running')]
  const client = {
    listWorkspaces: async () => ({
      activeWorkspaceKey: 'ws',
      activeTaskId: tasks[0].taskId,
      workspaces: [],
      tasks: tasks.map(t => ({ ...t })),
    }),
  }
  session.ensureClient = async () => client
  session.wsList = { activeWorkspaceKey: 'ws', activeTaskId: 't1', workspaces: [], tasks: tasks.map(t => ({ ...t })) }
  const first = await session.listStatus()
  assert('the first status read sees the current task', first.runningTaskIds[0] === 't1')
  tasks[0] = task('t1', 'completed')
  tasks.push(task('t2', 'running'))
  const second = await session.listStatus()
  assert('a later status read sees tasks that changed since the first call', second.runningTaskIds[0] === 't2')
  assert('the capacity guard reads the refreshed list too', await session.runningTaskCount() === 1)
}

// The capacity rule itself. `>= max` refuses, so exactly 3 running slots blocks a
// fourth dispatch; 2 still has room.
const refusal = capacityRefusal(3, 3)
assert('refuses a dispatch at the ceiling', typeof refusal === 'string' && refusal.includes('3 of 3'))
assert('refusal names the escape hatch', refusal.includes('zcode_remote_stop'))
assert('refusal is not dressed up as a pairing failure', !refusal.includes('pairing'))
assert('allows a dispatch below the ceiling', capacityRefusal(2, 3) === undefined)
assert('allows a dispatch on an idle client', capacityRefusal(0, 3) === undefined)
assert('counts above the ceiling still refuse', capacityRefusal(7, 3).includes('7 of 3'))
// An unreadable count must not block work: absence of evidence is not a full client.
assert('an unknown count does not refuse', capacityRefusal(null, 3) === undefined)
assert('a custom ceiling is honoured', capacityRefusal(3, 5) === undefined && capacityRefusal(5, 5) !== undefined)

// ---- A call-level failure must never release the pairing ----
// One link admits one connection, so a dropped pairing kills every sibling
// task on the client. A capacity refusal or a bad workspace selector is a
// problem with THIS call, not the connection — proven by sibling dispatches
// still working afterwards through the plugin's own session cache.
{
  const { apply } = await import('../lib/index.js')
  const { ZcodeRemoteSession } = await import('../lib/zcode-remote-client.js')
  const tools = new Map()
  let disposed = 0
  const wsList = {
    activeWorkspaceKey: 'D:\\x', activeTaskId: 't',
    workspaces: [{ workspacePath: 'D:\\x', workspaceIdentity: '' }],
    tasks: [task('a', 'running'), task('b', 'running')], // at the default ceiling of 2
  }
  const sent = []
  const stubClient = {
    state: 'paired', ws: { readyState: 1 },
    listen: () => () => {},
    listWorkspaces: async () => wsList,
    openBridge: async () => ({ bridgeSessionId: 'b', workspacePath: 'D:\\x', workspaceIdentity: '' }),
    agentHello: async () => ({}), agentInitialize: async () => ({}),
    subscribeConversation: async () => ({ ack: { subscriptionId: 'sub-1' } }),
    sendConversationCommand: async (_w, env) => { sent.push(env); return { status: 'accepted', result: { type: 'inputAccepted' } } },
    unsubscribeConversation: async () => ({ ok: true }),
    makeCommand: (s, t, p) => ({ commandId: 'c', clientId: 't', sessionId: s, type: t, payload: p, issuedAt: 1 }),
    close: () => {},
  }
  const origEnsure = ZcodeRemoteSession.prototype.ensureClient
  ZcodeRemoteSession.prototype.ensureClient = async function () { return stubClient }
  ZcodeRemoteSession.prototype.dispose = function () { disposed++ }
  try {
    apply({
      logger: {},
      effect: () => () => {},
      tools: { register: (t) => { tools.set(t.name, t); return () => {} } },
    }, { remoteUrl: 'https://zcode.z.ai/remote/v4?sid=S&hash=H' })
    const dispatch = tools.get('zcode_remote_dispatch')
    const status = tools.get('zcode_remote_status')

    let refusalError = null
    try { await dispatch.execute({ text: 'x', new_task: true }, { signal: { aborted: false } }) } catch (e) { refusalError = e }
    assert('a capacity refusal surfaces as a plain call error', refusalError?.message.includes('of 2'))
    assert('the refusal does not carry the pairing-release note', !refusalError?.message.includes('pairing was released'))
    assert('the refusal does not dispose the pairing', disposed === 0)

    let workspaceError = null
    try { await status.execute({ workspace: 'not-open-anywhere' }, { signal: { aborted: false } }) } catch (e) { workspaceError = e }
    assert('a bad workspace selector lists the open ones', workspaceError?.message.includes('D:\\x'))
    assert('the workspace error does not dispose the pairing', disposed === 0)

    // The pairing is alive if a later dispatch still works on the same session:
    // the desktop drops to one running task and two siblings go through.
    wsList.tasks = [task('a', 'running')]
    const r1 = await dispatch.execute({ text: 'sibling-1', session_id: 'sess_t', wait_seconds: 5, workspace: 'D:\\x' }, { signal: { aborted: false } })
    const r2 = await dispatch.execute({ text: 'sibling-2', session_id: 'sess_t', wait_seconds: 5, workspace: 'D:\\x' }, { signal: { aborted: false } })
    assert('a sibling dispatch after a refusal still works', r1.accepted === true && r2.accepted === true)
    assert('both siblings sent their messages', sent.filter(e => e.type === 'sendText').length === 2)
    assert('the pairing was never disposed across all four calls', disposed === 0)
  } finally {
    ZcodeRemoteSession.prototype.ensureClient = origEnsure
    delete ZcodeRemoteSession.prototype.dispose
  }
}
