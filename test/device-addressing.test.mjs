// Device addressing: a call names WHICH machine to act on.
//
// A link identifies one device pairing, so the tool surface accepts `device`
// (a configured name) or `url` (a raw link) and falls back to the default. The
// point of the feature is dispatching across machines, so the checks here are
// about target selection, not about the wire protocol.

import { apply, Config, name, inject, resolveTarget, pairingKey } from '../lib/index.js'

const assert = (label, ok) => {
  console.log(ok ? `PASS ${label}` : `FAIL ${label}`)
  if (!ok) process.exitCode = 1
}

const link = (sid, machine) => `https://zcode.z.ai/remote/v4?sid=${sid}&hash=H_${sid}&t=1&mid=M_${sid}&name=${machine}`

const LINK_A = link('S_A', 'Alpha')
const LINK_B = link('S_B', 'Beta')

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

assert('plugin name/inject unchanged', name === 'zcode-remote' && JSON.stringify(inject) === '["tools"]')

// Boot must not require any link: a profile starts before links are pasted.
try {
  Config({})
  assert('Config accepts an empty object (no link required at boot)', true)
} catch (error) {
  assert(`Config accepts an empty object (got ${error.message})`, false)
}
try {
  const parsed = Config({ devices: { alpha: LINK_A, beta: LINK_B }, device: 'beta' })
  assert('Config accepts a device map', parsed.devices.alpha === LINK_A && parsed.device === 'beta')
} catch (error) {
  assert(`Config accepts a device map (got ${error.message})`, false)
}

// ---- Five tools, all client-scoped except the roster ----
const multi = { devices: { alpha: LINK_A, beta: LINK_B }, device: 'beta' }
const tools = mount(multi)
assert('five tools registered', tools.size === 5)
assert('roster tool exists', tools.has('zcode_remote_devices'))
assert('collect tool exists', tools.has('zcode_remote_collect'))
assert('all client tools accept `device`',
  ['zcode_remote_dispatch', 'zcode_remote_status', 'zcode_remote_stop', 'zcode_remote_collect']
    .every(n => 'device' in (tools.get(n).parameters.properties ?? {})))
assert('all client tools accept `url`',
  ['zcode_remote_dispatch', 'zcode_remote_status', 'zcode_remote_stop', 'zcode_remote_collect']
    .every(n => 'url' in (tools.get(n).parameters.properties ?? {})))
assert('dispatch keeps its own parameters',
  ['text', 'session_id', 'wait_seconds', 'async', 'new_task']
    .every(p => p in tools.get('zcode_remote_dispatch').parameters.properties))
assert('`text` stays required', JSON.stringify(tools.get('zcode_remote_dispatch').parameters.required) === '["text"]')
assert('collect requires a task id',
  JSON.stringify(tools.get('zcode_remote_collect').parameters.required) === '["session_id"]')
// Concurrent tasks on one client must not serialize against each other. The
// classifier soft-validates its arguments first, so valid args must be given:
// invalid ones are exclusive by design.
assert('dispatch declares itself concurrency-safe',
  tools.get('zcode_remote_dispatch').isConcurrencySafe?.({ text: 'x' }) === true)
assert('collect declares itself concurrency-safe',
  tools.get('zcode_remote_collect').isConcurrencySafe?.({ session_id: 'sess_x' }) === true)

// ---- Target selection ----
assert('a named device selects that device\'s link',
  resolveTarget(multi, { device: 'alpha' }).url === LINK_A)
assert('the configured default applies with no arguments',
  resolveTarget(multi, {}).url === LINK_B)
assert('a raw link selects itself', resolveTarget(multi, { url: LINK_A }).url === LINK_A)
assert('a raw link beats the configured default', resolveTarget(multi, { url: LINK_A }).url === LINK_A)
assert('a named device wins over a link', resolveTarget(multi, { device: 'alpha', url: LINK_B }).url === LINK_A)
assert('a named device reports its label', resolveTarget(multi, { device: 'alpha' }).label === 'alpha')
assert('a raw link has no configured label', resolveTarget(multi, { url: LINK_A }).label === null)
assert('a blank device name falls back to the default', resolveTarget(multi, { device: '  ' }).url === LINK_B)
assert('a blank link falls back to the default', resolveTarget(multi, { url: '' }).url === LINK_B)

// A single-device setup, configured the original way, keeps working unchanged.
const single = { remoteUrl: LINK_A }
assert('a bare remoteUrl still works', resolveTarget(single, {}).url === LINK_A)
assert('a bare sid/hash pair still builds a link',
  resolveTarget({ remoteSid: 'S', remoteHash: 'H', remoteMid: 'M' }, {}).url.startsWith('https://zcode.z.ai/remote/v4?sid=S&hash=H'))

// ---- Failures must name what is wrong and what to do ----
const unknown = (() => { try { resolveTarget(multi, { device: 'gamma' }); return null } catch (e) { return e.message } })()
assert('an unknown device name fails', typeof unknown === 'string' && unknown.includes('unknown device "gamma"'))
assert('an unknown device lists the configured names', unknown.includes('alpha') && unknown.includes('beta'))

const badLink = (() => { try { resolveTarget(multi, { url: 'https://example.com/nope' }); return null } catch (e) { return e.message } })()
assert('a malformed link fails loud', typeof badLink === 'string' && badLink.includes('not a ZCode remote-control link'))

const badDefault = (() => { try { resolveTarget({ devices: { alpha: LINK_A }, device: 'ghost' }); return null } catch (e) { return e.message } })()
assert('a default naming an unknown device fails', typeof badDefault === 'string' && badDefault.includes('config.device "ghost"'))

const nothing = (() => { try { resolveTarget({}, {}); return null } catch (e) { return e.message } })()
assert('no configured device fails', typeof nothing === 'string' && nothing.includes('no device configured'))
assert('the no-device error names both remedies',
  nothing.includes('config.devices') && nothing.includes('`url`'))

const emptyMap = (() => { try { resolveTarget({ devices: {} }, { device: 'a' }); return null } catch (e) { return e.message } })()
assert('naming a device when none are configured fails', typeof emptyMap === 'string' && emptyMap.includes('(none'))

// ---- Pairing identity ----
assert('the pairing key is the sid', pairingKey(LINK_A) === 'S_A')
assert('two links with different sids are different pairings', pairingKey(LINK_A) !== pairingKey(LINK_B))
assert('a non-link falls back to itself', pairingKey('not-a-url') === 'not-a-url')

// ---- The roster needs no connection ----
// defineTool wraps execute as async, so every call must be awaited.
const roster = await tools.get('zcode_remote_devices').execute({})
assert('the roster lists both devices', roster.devices.length === 2)
assert('the roster marks the default', roster.devices.find(d => d.label === 'beta')?.default === true)
assert('the roster reports the machine name',
  roster.devices.find(d => d.label === 'alpha')?.machine === 'Alpha')
// Nothing has connected, so nothing may claim to be paired.
assert('the roster reports nothing paired yet', roster.devices.every(d => d.paired === false))

// A default set only through remoteUrl still appears in the roster.
const singleRoster = await mount({ remoteUrl: LINK_A }).get('zcode_remote_devices').execute({})
assert('a remoteUrl-only default appears in the roster',
  singleRoster.devices.length === 1 && singleRoster.devices[0].default === true)
assert('the roster reports its machine', singleRoster.devices[0].machine === 'Alpha')

const emptyRoster = await mount({}).get('zcode_remote_devices').execute({})
assert('an unconfigured roster is empty', emptyRoster.devices.length === 0)

// A malformed link in the map is reported as its own error, not as "unknown device".
const badMap = (() => { try { resolveTarget({ devices: { alpha: 'oops' } }, { device: 'alpha' }); return null } catch (e) { return e.message } })()
assert('a malformed configured link names the key', typeof badMap === 'string' && badMap.includes('config.devices.alpha'))
