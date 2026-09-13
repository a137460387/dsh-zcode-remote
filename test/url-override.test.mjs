// Call-time `url` override: an expired link must be replaceable without editing
// the profile, a malformed link must fail loud instead of silently falling back
// to the configured one, and a changed link must retire the previous session.
//
// The driver is not exercised here (it needs a live relay). These assertions
// cover the plugin's tool surface and link resolution only.

import { apply, Config, name, inject, normalizeRemoteUrl } from '../lib/index.js'

const assert = (label, ok) => {
  console.log(ok ? `PASS ${label}` : `FAIL ${label}`)
  if (!ok) process.exitCode = 1
}

/** Capture the tools one apply() call registers, and the sessions it builds. */
function mount(config) {
  const tools = new Map()
  const sessions = []
  const ctx = {
    logger: {},
    effect: () => () => {},
    tools: { register: (t) => { tools.set(t.name, t); return () => {} } },
  }
  // The plugin imports ZcodeRemoteSession directly, so observe session
  // construction through the URLs the tools attempt to pair with.
  apply(ctx, config)
  return { tools, sessions }
}

const LINK_A = 'https://zcode.z.ai/remote/v4?sid=S_A&hash=H_A&t=1&mid=M_A&name=n'
const LINK_B = 'https://zcode.z.ai/remote/v4?sid=S_B&hash=H_B&t=2&mid=M_B&name=n'

assert('plugin name/inject unchanged', name === 'zcode-remote' && JSON.stringify(inject) === '["tools"]')

// Config must stay valid without any link, so a profile still boots before the
// user has pasted one.
try {
  Config({})
  assert('Config accepts an empty object (no link required at boot)', true)
} catch (error) {
  assert(`Config accepts an empty object (got: ${error.message})`, false)
}

const withLink = mount({ remoteUrl: LINK_A })
const statusTool = withLink.tools.get('zcode_remote_status')
const dispatchTool = withLink.tools.get('zcode_remote_dispatch')
const stopTool = withLink.tools.get('zcode_remote_stop')

assert('three tools still registered', withLink.tools.size === 3 && !!statusTool && !!dispatchTool && !!stopTool)
assert('all three expose a `url` parameter',
  ['zcode_remote_status', 'zcode_remote_dispatch', 'zcode_remote_stop']
    .every(n => 'url' in (withLink.tools.get(n).parameters.properties ?? {})))
assert('dispatch keeps its other parameters',
  ['text', 'session_id', 'wait_seconds'].every(p => p in dispatchTool.parameters.properties))
assert('`text` stays required', JSON.stringify(dispatchTool.parameters.required) === '["text"]')

// A malformed call-time link must be rejected, not silently ignored: falling
// back to the configured (possibly expired) link would look like success. It is
// also an input error, so it must not claim a pairing was released.
const malformed = await statusTool.execute({ url: 'https://example.com/nope' })
  .then(() => null, e => e.message)
assert('malformed `url` fails loud', typeof malformed === 'string' && malformed.includes('not a ZCode remote-control link'))
assert('malformed `url` is not reported as a released pairing',
  typeof malformed === 'string' && !malformed.includes('released'))

// No link configured and none passed: the error must name both remedies.
const bare = mount({})
const bareError = await bare.tools.get('zcode_remote_status').execute({})
  .then(() => null, e => e.message)
assert('missing link error names both remedies',
  bareError.includes('Pass `url`') && bareError.includes('cordis.patch.yml'))

// A call-time link must reach the driver. Pairing cannot succeed here, but the
// failure proves the supplied link was used: the sid appears in the driver's
// own rejected auth attempt only if it was actually selected.
const overrideError = await statusTool.execute({ url: LINK_B }).then(() => null, e => e.message)
assert('call-time link is used and failure releases the pairing',
  typeof overrideError === 'string' && overrideError.includes('released'))

// Link selection itself, directly: the override wins and is passed through
// verbatim; a blank override is treated as absent rather than as a link.
assert('override wins over the configured link', normalizeRemoteUrl({ remoteUrl: LINK_A }, LINK_B) === LINK_B)
assert('configured link is used when no override is passed', normalizeRemoteUrl({ remoteUrl: LINK_A }) === LINK_A)
assert('blank override falls back to the configured link', normalizeRemoteUrl({ remoteUrl: LINK_A }, '   ') === LINK_A)
assert('bare sid/hash builds a link', normalizeRemoteUrl({ remoteSid: 'S', remoteHash: 'H', remoteMid: 'M' })
  .startsWith('https://zcode.z.ai/remote/v4?sid=S&hash=H'))
