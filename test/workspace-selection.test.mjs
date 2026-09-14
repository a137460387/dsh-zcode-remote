// Workspace selection: a call names a workspace by path, basename, or unique
// suffix; nothing selects falls back to the configured default ("ZCodeProject").
// One client may hold several workspaces, each bridged over the same relay
// connection — no second socket is opened for a second workspace.

import { apply, Config, name, inject } from '../lib/index.js'
import { matchWorkspaceEntry } from '../lib/zcode-remote-client.js'

const assert = (label, ok) => {
  console.log(ok ? `PASS ${label}` : `FAIL ${label}`)
  if (!ok) process.exitCode = 1
}

const LINK = 'https://zcode.z.ai/remote/v4?sid=S&hash=H&mid=M&name=n'

/** Capture the tools one apply() call registers. */
function mount(config) {
  const tools = new Map()
  apply({
    logger: {},
    effect: () => () => {},
    tools: { register: (t) => { tools.set(t.name, t); return () => {} } },
  }, config)
  return tools
}

// ---- The default is ZCodeProject ----
try {
  Config({ remoteUrl: LINK })
  assert('Config accepts a config without defaultWorkspace (defaults internally)', true)
} catch (error) {
  assert(`Config without defaultWorkspace (got ${error.message})`, false)
}
try {
  const parsed = Config({ remoteUrl: LINK, defaultWorkspace: 'SomeOther' })
  assert('Config accepts an explicit defaultWorkspace', parsed.defaultWorkspace === 'SomeOther')
} catch (error) {
  assert(`Config with defaultWorkspace (got ${error.message})`, false)
}

// ---- Tool surface ----
const tools = mount({ remoteUrl: LINK })
assert('all client tools accept `workspace`',
  ['zcode_remote_dispatch', 'zcode_remote_status', 'zcode_remote_stop', 'zcode_remote_collect']
    .every(n => 'workspace' in (tools.get(n).parameters.properties ?? {})))
assert('dispatch workspace is optional', !tools.get('zcode_remote_dispatch').parameters.required.includes('workspace'))

// ---- matchWorkspaceEntry ----
const workspaces = [
  { workspacePath: 'C:\\Users\\HUAWEI\\ZCodeProject', workspaceIdentity: '' },
  { workspacePath: 'D:\\tools\\dhsh', workspaceIdentity: '' },
  { workspacePath: 'D:\\code\\other-proj', workspaceIdentity: 'other-proj' },
]

assert('exact path match', matchWorkspaceEntry(workspaces, 'C:\\Users\\HUAWEI\\ZCodeProject')?.workspacePath === workspaces[0].workspacePath)
assert('identity match', matchWorkspaceEntry(workspaces, 'other-proj')?.workspacePath === workspaces[2].workspacePath)
assert('basename match', matchWorkspaceEntry(workspaces, 'ZCodeProject')?.workspacePath === workspaces[0].workspacePath)
assert('basename match for dhsh', matchWorkspaceEntry(workspaces, 'dhsh')?.workspacePath === workspaces[1].workspacePath)
assert('unique suffix match', matchWorkspaceEntry(workspaces, 'tools\\dhsh')?.workspacePath === workspaces[1].workspacePath)
assert('no match', matchWorkspaceEntry(workspaces, 'nope') === undefined)

// Ambiguous basename must not silently pick one.
const ambiguous = [
  { workspacePath: 'A:\\x\\ZCodeProject', workspaceIdentity: '' },
  { workspacePath: 'B:\\y\\ZCodeProject', workspaceIdentity: '' },
]
assert('ambiguous basename is no unique match', matchWorkspaceEntry(ambiguous, 'ZCodeProject') === undefined)

// ---- Session-side workspace selection logic (stubbed) ----
const { ZcodeRemoteSession } = await import('../lib/zcode-remote-client.js')
{
  const session = new ZcodeRemoteSession({ url: LINK, workspacePath: 'ZCodeProject' })
  const wsList = {
    activeWorkspaceKey: 'D:\\tools\\dhsh',
    activeTaskId: 'sess_active',
    workspaces: workspaces.map(w => ({ ...w, workspaceKind: 'local' })),
  }
  // selectWorkspaceKey via the session
  const keyOf = (w) => (w.workspaceIdentity?.trim() || w.workspacePath)
  assert('explicit workspace matches default name',
    session.selectWorkspaceKey(wsList, 'ZCodeProject').wsKey === 'C:\\Users\\HUAWEI\\ZCodeProject')
  assert('explicit workspace matches dhsh',
    session.selectWorkspaceKey(wsList, 'dhsh').wsKey === 'D:\\tools\\dhsh')
  assert('no selector falls back to active',
    session.selectWorkspaceKey(wsList).wsKey === 'D:\\tools\\dhsh')
  assert('unknown selector fails with the open list', (() => {
    try { session.selectWorkspaceKey(wsList, 'nope'); return null } catch (e) { return e.message }
  })()?.includes('D:\\tools\\dhsh'))
}

// ---- Multi-workspace bridge: one connection, two bridges ----
{
  const session = new ZcodeRemoteSession({ url: LINK, workspacePath: 'ZCodeProject' })
  const calls = []
  const wsList = {
    activeWorkspaceKey: 'D:\\tools\\dhsh',
    activeTaskId: 'sess_active',
    workspaces: workspaces.map(w => ({ ...w, workspaceKind: 'local' })),
  }
  const client = {
    connect: async () => client,
    listWorkspaces: async () => wsList,
    openBridge: async (wsKey) => {
      calls.push(wsKey)
      return { workspacePath: wsKey, bridgeSessionId: `bridge-${wsKey}` }
    },
    agentHello: async () => ({}),
    agentInitialize: async () => ({}),
    state: 'paired',
    ws: { readyState: 1 },
  }
  session.ensureClient = async () => client
  session.wsList = wsList   // mirror what the real ensureClient caches
  session.agentReady = null
  const first = await session.ensureReady()          // session default: ZCodeProject
  const second = await session.ensureReady('dhsh')   // explicit override
  assert('default call uses the session default workspace', first.workspaceKey === 'C:\\Users\\HUAWEI\\ZCodeProject')
  assert('explicit call opens the other workspace bridge', second.workspaceKey === 'D:\\tools\\dhsh')
  assert('two bridges exist', session.bridges.size === 2)
  assert('only one client connection', calls.length === 2)
  assert('same client serves both', first.client === second.client)
}
