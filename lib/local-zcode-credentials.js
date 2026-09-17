import { createDecipheriv, createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'

const CREDENTIAL_PREFIX = 'enc:v1:'
const CREDENTIAL_ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const AUTH_TAG_BYTES = 16

/**
 * Decrypt one value from ZCode's local credential store.
 * @param {string} value - Plain or `enc:v1` credential value.
 * @param {string} secret - The exact secret used by the ZCode desktop process.
 * @returns {string} the decrypted credential.
 */
export function decryptZCodeCredential(value, secret) {
  if (typeof value !== 'string' || value === '') throw new Error('ZCode credential is empty')
  if (!value.startsWith(CREDENTIAL_PREFIX)) return value
  const parts = value.slice(CREDENTIAL_PREFIX.length).split('.')
  if (parts.length !== 3 || parts.some(part => part === '')) {
    throw new Error('ZCode credential has an invalid encrypted format')
  }
  const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, 'base64url'))
  if (iv.length !== IV_BYTES) throw new Error('ZCode credential has an invalid IV length')
  if (tag.length !== AUTH_TAG_BYTES) throw new Error('ZCode credential has an invalid auth tag length')
  try {
    const key = createHash('sha256').update(secret).digest()
    const decipher = createDecipheriv(CREDENTIAL_ALGORITHM, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('ZCode credential decryption failed: the configured home/username does not match the ZCode desktop user, or the credential was encrypted with ZCODE_CREDENTIAL_SECRET')
  }
}

/**
 * Build the fallback credential secret used by ZCode on Windows.
 * @param {string} home - The ZCode desktop user's home directory.
 * @param {string} username - The ZCode desktop user's account name.
 * @returns {string} the fallback secret before SHA-256 derivation.
 */
export function zcodeFallbackSecret(home, username) {
  return `zcode-credential-fallback:win32:${home}:${username}`
}

/** Read and parse one ZCode JSON state file without exposing credential values in errors. */
function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read local ZCode ${label}: ${error?.message ?? error}`)
  }
}

/**
 * Derive the ZCode process user's home directory from an instance data dir.
 *
 * zcode-multi slots set ZCODE_DATA_BASE_DIR/ZCODE_HOME to
 * `<user>\AppData\Roaming\zcode-multi\<N>\data` but leave USERPROFILE untouched,
 * so the credential fallback secret is still derived from the REAL user home
 * (`<user>`). In a service context `os.homedir()`/USERPROFILE point at the
 * service account (e.g. SYSTEM), not the ZCode user, so the slot data dir is
 * the reliable source for the real user home.
 *
 * @param {string} home - The instance data dir passed by the caller.
 * @returns {string | null} the real user home, when `home` is a slot data dir.
 */
function deriveUserHomeFromSlotDataDir(home) {
  const m = /^(.+?)[\\/]AppData[\\/]Roaming[\\/]zcode-multi[\\/]\d+[\\/]data$/i.exec(home)
  return m ? m[1] : null
}

/**
 * Candidate fallback secrets for one instance, ordered by likelihood.
 * @param {{ home: string, username?: string, secretHome?: string }} config
 * @returns {Array<[string, string]>} [label, secret] pairs.
 */
export function credentialSecretCandidates(config) {
  const home = config.home
  const username = typeof config.username === 'string' && config.username.trim()
    ? config.username.trim()
    : basename(home)
  const secretHome = typeof config.secretHome === 'string' && config.secretHome.trim()
    ? config.secretHome.trim()
    : (deriveUserHomeFromSlotDataDir(home) ?? home)

  const out = []
  const push = (label, secret) => out.push([label, secret])
  push('secret-home', zcodeFallbackSecret(secretHome, username))
  const slotUser = deriveUserHomeFromSlotDataDir(home)
  if (slotUser && slotUser !== secretHome) {
    push('slot-user-home', zcodeFallbackSecret(slotUser, username))
  }
  if (home !== secretHome) {
    push('home-arg', zcodeFallbackSecret(home, username))
  }
  // Deduplicate.
  const seen = new Set()
  return out.filter(([, secret]) => {
    if (seen.has(secret)) return false
    seen.add(secret)
    return true
  })
}

/** Read the `web-remote-control:external-relay:pass_hash` encrypted value, or throw. */
function readEncryptedHash(stateDir) {
  const credentials = readJson(join(stateDir, 'credentials.json'), 'credentials.json')
  const enc = credentials['web-remote-control:external-relay:pass_hash']
  if (!enc) throw new Error('local ZCode credentials.json has no remote-control pass_hash; enable Mobile Remote Control in ZCode (it may be mid re-registration — retry shortly)')
  return enc
}

/** Decrypt `pass_hash` with the first working candidate secret. */
function decryptPassHash(enc, config) {
  for (const [, secret] of credentialSecretCandidates(config)) {
    try {
      return decryptZCodeCredential(enc, secret)
    } catch {
      // try next candidate
    }
  }
  throw new Error('local ZCode pass_hash could not be decrypted with any candidate key; check config.localDevice.username/secretHome against the ZCode desktop user')
}

// --- sid recovery from the instance's own logs ---
// The shared setting.json is unreliable for multi-open slots (ZCode's
// settingService writes sid to the real-user home setting.json, so sibling
// slots overwrite each other). The instance's own log dir is the reliable
// per-instance source: it logs its own registrations and, in several lines,
// the full sid.

const RE_AUTH_SAVED = /\[[^\]]+\].*?\[web-remote-control\] external relay auth saved \{"hasDeviceSid":true,"deviceSidSuffix":"([A-Za-z0-9_-]{1,12})"/g
const RE_FULL_SID = /(?:session"?\s*[:=]\s*"?|"deviceSid":")(d_[A-Za-z0-9_-]{6,64})/g

function logFiles(stateDir) {
  const dir = join(stateDir, 'logs')
  let files = []
  try {
    files = readdirSync(dir).filter(f => f.endsWith('.log')).sort()
  } catch {
    return files
  }
  return files.map(f => join(dir, f))
}

/**
 * Recover the full sid an instance most recently registered, from its logs.
 * @param {string} stateDir - `<home>/.zcode/v2`.
 * @returns {string | null} the full sid, or null when logs carry no evidence.
 */
export function recoverSidFromLogs(stateDir) {
  const saved = [] // [{ suffix, ts }]
  const full = new Map() // sid -> ts
  for (const file of logFiles(stateDir)) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const line of text.split(/\r?\n/)) {
      for (const m of line.matchAll(RE_AUTH_SAVED)) {
        saved.push({ suffix: m[1], ts: line.match(/^\[([^\]]+)\]/)?.[1] ?? '' })
      }
      for (const m of line.matchAll(RE_FULL_SID)) {
        full.set(m[1], line.match(/^\[([^\]]+)\]/)?.[1] ?? '')
      }
    }
  }
  if (!saved.length) return null
  saved.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  const newest = saved[saved.length - 1]
  // Prefer a logged full sid whose suffix matches the newest own registration.
  const matches = [...full.keys()].filter(sid => sid.endsWith(newest.suffix))
  if (matches.length) return matches[matches.length - 1]
  return null
}

/**
 * Reconstruct a remote-control URL from a local ZCode desktop user's state.
 *
 * `home` is the instance data dir: the real user home for the default instance,
 * or `<user>\AppData\Roaming\zcode-multi\<N>\data` for a multi-open slot. The
 * sid is recovered from the instance's own logs (authoritative) with a fallback
 * to the shared setting.json; the hash is decrypted with the real user's key.
 *
 * @param {{ home: string, username?: string, secretHome?: string, name?: string, sharedSetting?: string }} config
 * @returns {string} a v4 remote-control URL carrying the current local credentials.
 */
export function localZCodeRemoteUrl(config) {
  const home = typeof config?.home === 'string' ? config.home.trim() : ''
  if (!home) throw new Error('config.localDevice.home is required for local ZCode discovery')

  const stateDir = join(home, '.zcode', 'v2')
  const telemetry = readJson(join(stateDir, 'telemetry-state.json'), 'telemetry-state.json')
  const deviceMid = telemetry.deviceMid?.trim()
  if (!deviceMid) throw new Error('local ZCode telemetry-state.json has no deviceMid')

  const encryptedHash = readEncryptedHash(stateDir)
  const passHash = decryptPassHash(encryptedHash, config)

  // Authoritative sid: this instance's own log. Fall back to the shared
  // setting.json (only trustworthy for the default instance; slots need logs).
  let deviceSid = recoverSidFromLogs(stateDir)
  if (!deviceSid && config.sharedSetting) {
    const settings = readJson(config.sharedSetting, 'shared setting.json')
    deviceSid = settings.webRemoteControlExternalRelayDevice?.deviceSid?.trim()
  }
  if (!deviceSid) {
    throw new Error('could not recover the remote-control sid for this instance; re-enable Mobile Remote Control in ZCode and retry')
  }

  const url = new URL('https://zcode.z.ai/remote/v4')
  url.searchParams.set('sid', deviceSid)
  url.searchParams.set('hash', passHash)
  url.searchParams.set('t', String(Date.now()))
  url.searchParams.set('mid', deviceMid)
  url.searchParams.set('name', typeof config.name === 'string' && config.name.trim() ? config.name.trim() : hostname())
  return url.toString()
}
