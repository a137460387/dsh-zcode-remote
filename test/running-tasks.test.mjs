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
