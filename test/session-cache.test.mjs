// Per-device session isolation.
//
// The reason this plugin holds more than one pairing: dispatching to machine B
// must not disturb machine A's live session, or switching back would re-pair
// every time and drop A's subscription. These checks use a stub factory, so no
// relay is needed to verify the cache's behaviour.

import { createSessionCache, resolveTarget } from '../lib/index.js'

const assert = (label, ok) => {
  console.log(ok ? `PASS ${label}` : `FAIL ${label}`)
  if (!ok) process.exitCode = 1
}

const link = (sid, machine) => `https://zcode.z.ai/remote/v4?sid=${sid}&hash=H_${sid}&t=1&mid=M_${sid}&name=${machine}`
const LINK_A = link('S_A', 'Alpha')
const LINK_B = link('S_B', 'Beta')

/** A cache whose sessions record their own lifecycle. */
function makeCache() {
  const built = []
  let disposed = 0
  const cache = createSessionCache((url) => {
    const session = { url, disposed: false, dispose() { this.disposed = true; disposed++ } }
    built.push(session)
    return session
  })
  return { cache, built, disposalCount: () => disposed }
}

// ---- One session per device, created on demand ----
{
  const { cache, built } = makeCache()
  assert('nothing is built before first use', built.length === 0)
  const a1 = cache.acquire(LINK_A)
  assert('acquiring builds one session', built.length === 1)
  const a2 = cache.acquire(LINK_A)
  assert('acquiring the same device reuses it', a1 === a2 && built.length === 1)
  const b1 = cache.acquire(LINK_B)
  assert('acquiring another device builds a second session', built.length === 2 && b1 !== a1)
  assert('the first device is left alone', a1.disposed === false)
  const a3 = cache.acquire(LINK_A)
  assert('switching back reuses the first device', a3 === a1 && built.length === 2)
  assert('neither device was disposed by switching', a1.disposed === false && b1.disposed === false)
  assert('both pairings are held', cache.keys().length === 2)
}

// ---- Releasing one device leaves the others connected ----
{
  const { cache, built } = makeCache()
  const a = cache.acquire(LINK_A)
  const b = cache.acquire(LINK_B)
  cache.release(LINK_A)
  assert('releasing one device disposes only it', a.disposed === true && b.disposed === false)
  assert('the other pairing is still held', cache.keys().length === 1)
  const b2 = cache.acquire(LINK_B)
  assert('the surviving device is not rebuilt', b2 === b && built.length === 2)
  const a2 = cache.acquire(LINK_A)
  assert('the released device rebuilds on demand', a2 !== a && built.length === 3)
}

// ---- Releasing an unknown device is a no-op ----
{
  const { cache, built } = makeCache()
  cache.acquire(LINK_A)
  cache.release(LINK_B)
  assert('releasing an unpaired device changes nothing', built.length === 1)
}

// ---- A re-issued link for the SAME pairing replaces the session ----
// The desktop re-issues a link with a fresh timestamp and credential; the sid
// still identifies the same pairing, so the stale session must be replaced.
{
  const { cache, built } = makeCache()
  const first = cache.acquire(LINK_A)
  const reissued = `https://zcode.z.ai/remote/v4?sid=S_A&hash=NEW&t=999&mid=M_S_A&name=Alpha`
  const second = cache.acquire(reissued)
  assert('a re-issued link replaces the session', second !== first && built.length === 2)
  assert('the stale session was disposed', first.disposed === true)
  assert('the pairing id is unchanged', cache.keys().length === 1)
  assert('re-acquiring the new link reuses it', cache.acquire(reissued) === second)
}

// ---- Teardown ----
{
  const { cache } = makeCache()
  const a = cache.acquire(LINK_A)
  const b = cache.acquire(LINK_B)
  cache.releaseAll()
  assert('releaseAll disposes every device', a.disposed === true && b.disposed === true)
  assert('releaseAll clears the roster of pairings', cache.keys().length === 0)
}

// ---- End-to-end shape: two devices addressed in one config ----
{
  const config = { devices: { alpha: LINK_A, beta: LINK_B } }
  const { cache } = makeCache()
  const alpha = cache.acquire(resolveTarget(config, { device: 'alpha' }).url)
  const beta = cache.acquire(resolveTarget(config, { device: 'beta' }).url)
  assert('addressing two devices yields two distinct sessions', alpha !== beta)
  assert('both remain connected', alpha.disposed === false && beta.disposed === false)
}
