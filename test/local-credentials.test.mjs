import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveTarget } from '../lib/index.js'
import { decryptZCodeCredential, localZCodeRemoteUrl, recoverSidFromLogs, zcodeFallbackSecret, credentialSecretCandidates } from '../lib/local-zcode-credentials.js'

const assert = (label, ok) => {
  console.log(ok ? `PASS ${label}` : `FAIL ${label}`)
  if (!ok) process.exitCode = 1
}

function encryptCredential(cleartext, secret) {
  const iv = randomBytes(12)
  const key = createHash('sha256').update(secret).digest()
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(cleartext, 'utf8'), cipher.final()])
  return `enc:v1:${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`
}

// Fixture mirrors the REAL ZCode layout: the instance data dir holds
// telemetry-state.json + credentials.json + logs/; the shared setting.json
// (sid) lives elsewhere — and for slots it is untrusted, so the authoritative
// sid comes from the instance's own log lines.
const home = mkdtempSync(join(tmpdir(), 'zcode-local-'))
const stateDir = join(home, '.zcode', 'v2')
mkdirSync(join(stateDir, 'logs'), { recursive: true })
const username = 'deskuser'
const passHash = 'test-pass-hash-that-never-leaves-the-fixture'
const secret = zcodeFallbackSecret(home, username)
const fullSid = 'd_TESTFULLSID000000000000000'
const suffix = fullSid.slice(-6)

writeFileSync(join(stateDir, 'telemetry-state.json'), JSON.stringify({ deviceMid: 'M_LOCAL' }))
writeFileSync(join(stateDir, 'credentials.json'), JSON.stringify({
  'web-remote-control:external-relay:pass_hash': encryptCredential(passHash, secret),
}))
writeFileSync(join(stateDir, 'logs', '2026-09-16.log'), [
  `[2026-09-16 02:05:46.127] [info] [pid:180] [main] [web-remote-control] external relay auth saved {"hasDeviceSid":true,"deviceSidSuffix":"${suffix}","hasPassHash":true}`,
  `[2026-09-16 02:05:50.000] [info] [pid:180] [main] [web-remote-control] dropped buffered outbound payloads {"windowId":1,"session":"${fullSid}","droppedCount":1}`,
].join('\n'))

assert('encrypted credentials decrypt with the matching desktop identity',
  decryptZCodeCredential(JSON.parse(readFileSync(join(stateDir, 'credentials.json'), 'utf8'))['web-remote-control:external-relay:pass_hash'], secret) === passHash)

assert('recoverSidFromLogs returns the full sid matching the newest auth saved suffix',
  recoverSidFromLogs(stateDir) === fullSid)

// Secret candidates: the real user home is derivable from a slot data dir.
assert('credentialSecretCandidates derives the real user home from a slot data dir',
  credentialSecretCandidates({ home: 'C:\\Users\\desk\\AppData\\Roaming\\zcode-multi\\2\\data', username })
    .some(([, s]) => s === zcodeFallbackSecret('C:\\Users\\desk', username)))

const url = localZCodeRemoteUrl({ home, username, name: 'LocalBox' })
const parsed = new URL(url)
assert('local discovery reconstructs the sid from the instance log', parsed.searchParams.get('sid') === fullSid)
assert('local discovery decrypts the pairing credential', parsed.searchParams.get('hash') === passHash)
assert('local discovery carries the machine id and configured name',
  parsed.searchParams.get('mid') === 'M_LOCAL' && parsed.searchParams.get('name') === 'LocalBox')
assert('local discovery emits a fresh timestamp', Number(parsed.searchParams.get('t')) > 0)

// Fallback path: when logs carry no sid, a provided sharedSetting path is used.
const sharedDir = mkdtempSync(join(tmpdir(), 'zcode-shared-'))
const sharedSetting = join(sharedDir, 'setting.json')
writeFileSync(sharedSetting, JSON.stringify({ webRemoteControlExternalRelayDevice: { deviceSid: fullSid } }))
const noLogHome = mkdtempSync(join(tmpdir(), 'zcode-nolog-'))
mkdirSync(join(noLogHome, '.zcode', 'v2'), { recursive: true })
const noLogSecret = zcodeFallbackSecret(noLogHome, username)
writeFileSync(join(noLogHome, '.zcode', 'v2', 'telemetry-state.json'), JSON.stringify({ deviceMid: 'M_LOCAL' }))
writeFileSync(join(noLogHome, '.zcode', 'v2', 'credentials.json'), JSON.stringify({
  'web-remote-control:external-relay:pass_hash': encryptCredential(passHash, noLogSecret),
}))
const fallbackUrl = localZCodeRemoteUrl({ home: noLogHome, username, sharedSetting })
assert('a provided sharedSetting path supplies the sid when logs are empty',
  new URL(fallbackUrl).searchParams.get('sid') === fullSid)

const target = resolveTarget({ localDevice: { home, username, label: 'desktop', name: 'LocalBox' } }, {})
assert('local discovery is the default when no URL device is configured', target.label === 'desktop' && target.url.includes(`sid=${fullSid}`))
assert('the local label can be addressed explicitly',
  resolveTarget({ localDevice: { home, username, label: 'desktop' } }, { device: 'desktop' }).label === 'desktop')

// localDevices: a named slot instance.
const slotHome = mkdtempSync(join(tmpdir(), 'zcode-slot-'))
const slotState = join(slotHome, '.zcode', 'v2')
mkdirSync(join(slotState, 'logs'), { recursive: true })
const slotSecret = zcodeFallbackSecret(slotHome, username)
writeFileSync(join(slotState, 'telemetry-state.json'), JSON.stringify({ deviceMid: 'M_SLOT' }))
writeFileSync(join(slotState, 'credentials.json'), JSON.stringify({
  'web-remote-control:external-relay:pass_hash': encryptCredential(passHash, slotSecret),
}))
const slotSid = 'd_SLOTFULLSID00000000000000000'
const slotSuffix = slotSid.slice(-6)
writeFileSync(join(slotState, 'logs', '2026-09-16.log'), [
  `[2026-09-16 03:00:00.000] [info] [main] [web-remote-control] external relay auth saved {"hasDeviceSid":true,"deviceSidSuffix":"${slotSuffix}","hasPassHash":true}`,
  `[2026-09-16 03:00:01.000] [info] [main] [web-remote-control] dropped buffered outbound payloads {"session":"${slotSid}"}`,
].join('\n'))
assert('a named localDevices slot is addressable by its key',
  resolveTarget({ localDevices: { s2: { home: slotHome, username } } }, { device: 's2' }).url.includes(`sid=${slotSid}`))

const remote = 'https://zcode.z.ai/remote/v4?sid=S_REMOTE&hash=H_REMOTE&t=1&mid=M_REMOTE&name=Remote'
assert('an explicit configured default still wins over local discovery',
  resolveTarget({ localDevice: { home, username }, remoteUrl: remote }, {}).url === remote)

const wrongIdentity = (() => {
  try {
    localZCodeRemoteUrl({ home, username: 'someone-else' })
    return null
  } catch (error) {
    return error.message
  }
})()
assert('a mismatched desktop identity gives an actionable error',
  wrongIdentity?.includes('could not be decrypted') && !wrongIdentity.includes(passHash))

const conflictingLabel = (() => {
  try {
    resolveTarget({ localDevice: { home, username, label: 'desktop' }, devices: { desktop: remote } }, {})
    return null
  } catch (error) {
    return error.message
  }
})()
assert('a local label cannot shadow a configured URL device', conflictingLabel?.includes('conflicts'))
