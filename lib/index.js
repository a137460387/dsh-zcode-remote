/**
 * dsh plugin: drive ZCode desktop agents through the mobile remote-control
 * relay, exactly like the phone client does. Registers five agent tools:
 *
 *   zcode_remote_dispatch — send a prompt to a desktop task, wait for and
 *                           return the streamed assistant reply; new tasks
 *                           start on a selectable model and reasoning level.
 *   zcode_remote_collect  — fetch a task's reply; survives restarts by
 *                           re-attaching to the conversation read-only.
 *   zcode_remote_status   — list a device's workspaces, tasks and running count.
 *   zcode_remote_devices  — list the devices this plugin can reach.
 *   zcode_remote_stop     — interrupt a running desktop task.
 *
 * One link identifies one device pairing, so a link passed to a tool call
 * selects WHICH device to act on; each device keeps its own live session, and
 * addressing device B never disturbs device A. Same-machine devices can be
 * discovered from the ZCode instance's own state instead of a configured link.
 *
 * @module dsh-zcode-remote
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { localZCodeRemoteUrl } from './local-zcode-credentials.js'
import { ZcodeRemoteSession } from './zcode-remote-client.js'

/** Cordis function-plugin name. */
export const name = 'zcode-remote'
/** Services required before this plugin registers its tools. */
export const inject = ['tools']

/** Schemastery configuration for the remote-control driver. */
export const Config = z.object({
  remoteUrl: z.string()
    .description('Default device: full zcode remote-control link (the one the mobile app opens), carrying sid, hash, t and mid query parameters.'),
  remoteSid: z.string().description('The sid query parameter of the remote link (alternative to remoteUrl).'),
  remoteHash: z.string().description('The hash query parameter of the remote link (alternative to remoteUrl).'),
  remoteMid: z.string().description('The mid query parameter of the remote link.'),
  remoteName: z.string().description('The name query parameter of the remote link.'),
  device: z.string()
    .description('Default device name: a key of `devices` to use when a call names no device or link.'),
  devices: z.dict(z.string())
    .description('Additional devices this plugin may dispatch to, as { name: remote-control link }. '
      + 'Each key becomes a `device` value a tool call can address, so a machine is picked by short name '
      + 'instead of by pasting its link. One device may be marked default via `device`.'),
  localDevice: z.object({
    home: z.string()
      .description('Windows home directory of a ZCode desktop user, for example C:\\Users\\NAME. The plugin reads that user\'s local ZCode state and reconstructs the link on demand. For a multi-open slot, use <user>\\AppData\\Roaming\\zcode-multi\\<N>\\data.'),
    username: z.string()
      .description('Windows username that encrypted the ZCode credential. Defaults to the basename of localDevice.home.'),
    secretHome: z.string()
      .description('Home directory used to derive the credential decryption key. Defaults to the real user home derived from home (for slots) or home itself. Only set this when the ZCode process user differs from the derived default.'),
    sharedSetting: z.string()
      .description('Optional path to the shared setting.json the app writes sid to (default: the real user home\'s .zcode/v2/setting.json). Used only as a fallback when the instance\'s own logs carry no sid.'),
    name: z.string()
      .description('Optional machine name written into the reconstructed link. Defaults to this host\'s hostname.'),
    label: z.string()
      .description('Device name exposed to tools for the locally discovered ZCode desktop. Defaults to "local".'),
  }).description('Discover the same-machine ZCode remote-control link from ~/.zcode/v2 without storing its hash in the profile.'),
  localDevices: z.dict(z.object({
    home: z.string(),
    username: z.string(),
    secretHome: z.string(),
    sharedSetting: z.string(),
    name: z.string(),
    label: z.string(),
  }))
    .description('Named same-machine ZCode instances (e.g. multi-open slots) discoverable by a short device name. Each value mirrors localDevice\'s fields; only `home` is required.'),
  maxRunningTasks: z.number()
    .description('Concurrently working tasks one ZCode client may run before this plugin refuses a dispatch. The desktop '
      + 'hard limit is 3 — a task beyond it makes the running ones stop — so the default is 2, the stable operating '
      + 'point. Reported alongside the observed count so a caller can tell whether another dispatch has room.'),
  clientKind: z.string()
    .description('clientKind announced in initializeConversationV4: web | mobileRemote | mobileApp | desktop.'),
  workspacePath: z.string().description('Pin the desktop workspace to bridge. Defaults to the desktop active workspace.'),
  defaultWorkspace: z.string()
    .description('Workspace used when a call names none: matched against the client\'s open workspaces by exact path, '
      + 'basename, or a unique trailing suffix. Defaults to "ZCodeProject", so a call that names no workspace lands in '
      + 'the ZCodeProject project without needing the full path.'),
  defaultModel: z.string()
    .description('Model a `new_task` dispatch starts with when the call names none. Defaults to "GLM-5.3-Flash" on the '
      + 'official Z.ai Start Plan channel.'),
  defaultThought: z.string()
    .description('Reasoning level a `new_task` dispatch starts with when the call names none: low | high | max. '
      + 'Defaults to "max" (最高).'),
  defaultProvider: z.string()
    .description('Provider id a `new_task` dispatch starts with when the call names none. Defaults to '
      + '"builtin:zai-start-plan", the official Z.ai channel.'),
  sessionId: z.string().description('Pin the default target task id (sess_*). Defaults to the desktop active task.'),
  waitSeconds: z.number().description('Default cap for waiting a reply after dispatch.'),
})

/** The `sid` that identifies one pairing, or the whole link when it has none. */
export function pairingKey(url) {
  try {
    return new URL(url).searchParams.get('sid') || url
  } catch {
    return url
  }
}

/** The machine name a link announces, for display. Never derived from `hash`. */
export function linkDeviceName(url) {
  try {
    return new URL(url).searchParams.get('name') || undefined
  } catch {
    return undefined
  }
}

/** Compare connection credentials while ignoring display fields and URL timestamps. */
function connectionKey(url) {
  try {
    const params = new URL(url).searchParams
    return [params.get('sid'), params.get('hash'), params.get('mid')].join('\u0000')
  } catch {
    return url
  }
}

/** Assert one value is a remote-control link. The `hash` is the credential. */
function assertLink(candidate, what) {
  if (typeof candidate !== 'string' || !candidate.includes('sid=') || !candidate.includes('hash=')) {
    throw new Error(`zcode-remote: ${what} is not a ZCode remote-control link (it must contain \`sid=\` and \`hash=\`). `
      + 'Copy the full link from that device\'s ZCode desktop app under Remote Control.')
  }
  return candidate
}

/** Build a link from the bare `sid`/`hash` config pair, when no full link was given. */
function linkFromParts(config) {
  if (!config.remoteSid || !config.remoteHash) return undefined
  const params = new URLSearchParams({ sid: config.remoteSid, hash: config.remoteHash, t: String(Date.now()) })
  if (config.remoteMid) params.set('mid', config.remoteMid)
  if (config.remoteName) params.set('name', config.remoteName)
  return `https://zcode.z.ai/remote/v4?${params.toString()}`
}

/** The configured label for same-machine credential discovery. */
function localDeviceLabel(config) {
  return typeof config.localDevice?.label === 'string' && config.localDevice.label.trim()
    ? config.localDevice.label.trim()
    : 'local'
}

/** Resolve the same-machine ZCode desktop without persisting its credential URL. */
function resolveLocalTarget(config) {
  return {
    url: assertLink(localZCodeRemoteUrl(config.localDevice), 'the locally discovered ZCode credential'),
    label: localDeviceLabel(config),
  }
}

/** Resolve one named same-machine instance from config.localDevices. */
function resolveLocalDevice(config, name) {
  const entry = config.localDevices?.[name]
  if (!entry) return null
  const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : name
  return {
    url: assertLink(localZCodeRemoteUrl({ ...entry, label }), `localDevices.${name}`),
    label,
  }
}

/**
 * Resolve which device a tool call targets, so a call may name a device by its
 * short configured name, discover the same-machine desktop, pass a link
 * directly, or fall back to the default.
 * @param {Record<string, any>} config - validated plugin config.
 * @param {{ device?: string, url?: string }} [args] - the call's addressing arguments.
 * @returns {{ url: string, label: string | null }} the link to pair with and the device name it came from.
 * @throws when a named device is unknown, a supplied link is malformed, or no device is configured.
 */
export function resolveTarget(config, args = {}) {
  const devices = config.devices ?? {}
  const localLabel = config.localDevice ? localDeviceLabel(config) : null
  const localNames = Object.keys(config.localDevices ?? {})
  const labels = [...Object.keys(devices), ...(localLabel ? [localLabel] : []), ...localNames]
  for (const name of labels) {
    if ((name === localLabel && Object.hasOwn(devices, name))
      || (localNames.includes(name) && Object.hasOwn(devices, name))) {
      throw new Error(`zcode-remote: device label "${name}" conflicts with config.devices.${name}`)
    }
  }

  if (typeof args.device === 'string' && args.device.trim() !== '') {
    const wanted = args.device.trim()
    if (wanted === localLabel) return resolveLocalTarget(config)
    if (localNames.includes(wanted)) return resolveLocalDevice(config, wanted)
    const configured = devices[wanted]
    if (configured === undefined) {
      throw new Error(`zcode-remote: unknown device "${wanted}". Configured devices: `
        + (labels.length ? labels.join(', ') : '(none; add config.localDevice, config.localDevices, or config.devices)'))
    }
    return { url: assertLink(configured, `config.devices.${wanted}`), label: wanted }
  }

  if (typeof args.url === 'string' && args.url.trim() !== '') {
    // Malformed links fail loud rather than falling back to the default device:
    // silently dispatching to the wrong machine would look like success.
    return { url: assertLink(args.url, 'the `url` argument'), label: null }
  }

  if (typeof config.device === 'string' && config.device.trim() !== '') {
    const wanted = config.device.trim()
    if (wanted === localLabel) return resolveLocalTarget(config)
    if (localNames.includes(wanted)) return resolveLocalDevice(config, wanted)
    const configured = devices[wanted]
    if (configured === undefined) {
      throw new Error(`zcode-remote: config.device "${wanted}" is not a configured device`
        + (labels.length ? ` (known: ${labels.join(', ')})` : ' (no devices configured)'))
    }
    return { url: assertLink(configured, `config.devices.${wanted}`), label: wanted }
  }

  if (config.remoteUrl?.includes('sid=')) return { url: config.remoteUrl, label: null }
  const built = linkFromParts(config)
  if (built) return { url: built, label: null }
  if (config.localDevice) return resolveLocalTarget(config)

  throw new Error('zcode-remote: no device configured. Set config.localDevice, config.localDevices, config.remoteUrl, or config.devices, '
    + 'or pass `url` with a device\'s remote-control link. The link is shown by that device\'s ZCode desktop app under Remote Control.')
}

/**
 * One live pairing per client, keyed by pairing id.
 *
 * Clients must not evict each other: a call addressing client B has to leave
 * client A paired, or switching back would re-pair every time and drop A's
 * subscription. Keying by `sid` matches the relay's own model — one link admits
 * exactly one terminal connection (`KICKED` otherwise) — so each link IS one
 * client-connection pair. Regenerating a link issues a NEW sid (verified live:
 * two links from one client shared a mid but had different sids), which is
 * correct here: the old link's connection is dead by then anyway.
 * @param {(url: string) => object} create - builds a session for a link.
 * @returns a cache with per-client acquire/release and bulk teardown.
 */
export function createSessionCache(create) {
  const entries = new Map()
  return {
    /** The live session for `url`, created on first use. Changed credentials under the same sid replace it. */
    acquire(url) {
      const key = pairingKey(url)
      const existing = entries.get(key)
      if (existing?.connectionKey === connectionKey(url)) return existing.session
      if (existing) existing.session.dispose?.()
      const session = create(url)
      entries.set(key, { connectionKey: connectionKey(url), session })
      return session
    },
    /** Drop one device's pairing, leaving every other device connected. */
    release(url) {
      const key = pairingKey(url)
      const existing = entries.get(key)
      if (!existing) return
      existing.session.dispose?.()
      entries.delete(key)
    },
    /** Every pairing id currently held, for diagnostics. */
    keys() {
      return [...entries.keys()]
    },
    /** Drop every device. Called on plugin stop. */
    releaseAll() {
      for (const { session } of entries.values()) session.dispose?.()
      entries.clear()
    },
  }
}

/**
 * Refuse a dispatch that would exceed the client's concurrent-task ceiling.
 * Kept separate from the tool body so the rule is testable without a live relay,
 * and deliberately returns a message rather than throwing: the caller decides
 * how to surface it.
 * @param {number | null} runningCount - observed running tasks, or null when unknown.
 * @param {number} maxRunningTasks - the ceiling for one client.
 * @returns a refusal message, or undefined when the dispatch may proceed.
 */
export function capacityRefusal(runningCount, maxRunningTasks) {
  if (typeof runningCount !== 'number' || runningCount < maxRunningTasks) return undefined
  return `the ZCode client already has ${runningCount} of ${maxRunningTasks} task slots running; `
    + 'wait for one to finish, or stop one with zcode_remote_stop, before dispatching another'
}

/** The addressing arguments every device-scoped tool accepts. */
const ADDRESSING_PARAMETERS = {
  device: {
    type: 'string',
    description: 'Which device to act on, by its configured name (a key of config.devices). '
      + 'Use this to dispatch to another machine. Omit to use the default device.',
  },
  url: {
    type: 'string',
    description: 'Which device to act on, given its full remote-control link (from THAT device\'s ZCode desktop app). '
      + 'Use when the machine is not configured under config.devices. Omit to use the default device.',
  },
  workspace: {
    type: 'string',
    description: 'Which workspace on the device to act on, by exact path, basename, or a unique trailing suffix '
      + '(e.g. "ZCodeProject" matches "C:\\Users\\HUAWEI\\ZCodeProject"). '
      + 'Omit to use the default workspace (config.defaultWorkspace, or the desktop\'s active one).',
  },
}

/** The message appended when a call fails, so the caller knows what to try next. */
const RELEASED_NOTE = '(only that client\'s pairing was released; other clients stay connected. '
  + 'If its link expired, get a fresh link from that client\'s ZCode desktop app.)'

/**
 * An error raised BY the call itself — a refusal, a bad selector, an unexpected
 * reply — rather than by the connection it ran on. `onDevice` never releases
 * the pairing for these: the socket is fine and sibling tasks keep streaming.
 * @param {string} message - what went wrong and what to try.
 */
export class UsageError extends Error {}

/**
 * Recursively drop properties whose value is undefined. Tool outputs must
 * survive a JSON round trip intact, and `JSON.stringify` silently discards
 * undefined-valued keys — dsh's output validator rejects the result as "not
 * lossless JSON". Real desktops omit fields (displayStatus is missing on some
 * clients), so results are pruned before returning.
 * @param {any} value - the tool output to clean.
 * @returns a value with no undefined-valued property anywhere.
 */
export function pruneUndefined(value) {
  if (Array.isArray(value)) return value.map(v => pruneUndefined(v))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v !== undefined) out[k] = pruneUndefined(v)
    }
    return out
  }
  return value
}

/** Key one in-flight dispatch, so `collect` can find it later. */
function dispatchKey(url, taskId) {
  return `${pairingKey(url)}::${taskId}`
}

/**
 * Register the remote-control tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - cordis context.
 * @param {Record<string, any>} config - validated plugin config.
 */
export function apply(ctx, config) {
  // The desktop stops running tasks when a client exceeds 3 concurrent ones, so
  // the guard defaults to 2 — the stable operating point — and `maxRunningTasks`
  // raises it for callers who want to push the limit.
  const MAX_RUNNING_TASKS = config.maxRunningTasks ?? 2
  const DEFAULT_WORKSPACE = config.defaultWorkspace ?? 'ZCodeProject'
  // What a new task starts on when the call names nothing. The desktop silently
  // replaces invalid values with its own defaults; the tool result's `config`
  // field reports what the subscription snapshot actually applied.
  const DEFAULT_MODEL = config.defaultModel ?? 'GLM-5.3-Flash'
  const DEFAULT_THOUGHT = config.defaultThought ?? 'max'
  const DEFAULT_PROVIDER = config.defaultProvider ?? 'builtin:zai-start-plan'
  // Sessions are created lazily so a profile boots cleanly even before any link
  // is configured; the tools explain what to pass instead.
  const cache = createSessionCache(url => new ZcodeRemoteSession({
    url,
    clientKind: config.clientKind ?? 'web',
    workspacePath: config.workspacePath ?? DEFAULT_WORKSPACE,
    sessionId: config.sessionId,
    log: (...parts) => ctx.logger?.debug?.(['zcode-remote', ...parts].join(' ')),
  }))
  // Dispatches that were started without waiting, so `zcode_remote_collect` can
  // pick each up by its client and task. One entry per running task, because one
  // client may hold several at once.
  const inflight = new Map()
  ctx.effect(() => () => {
    inflight.clear()
    cache.releaseAll()
  }, 'zcode-remote: dispose all client sessions')

  /**
   * Run one client-scoped operation. Only a CONNECTION failure releases the
   * client's pairing: one link admits one relay connection, so a dropped pairing
   * takes down every task on that client. A call-level failure — a cancelled
   * collect, a refused dispatch — must leave the pairing and its other tasks
   * alone.
   * @param {object} args - the call's addressing arguments.
   * @param {(session: object, target: object) => Promise<any>} run - the operation.
   * @param {{ signal?: AbortSignal }} [exec] - the tool execution, for its cancellation signal.
   */
  const onDevice = async (args, run, exec) => {
    // Resolve the target before the try: an unknown name or malformed link is an
    // input error, not a connection failure.
    const target = resolveTarget(config, args)
    const session = cache.acquire(target.url)
    try {
      // The workspace selector resolves against the client's open workspaces;
      // nothing selects falls back to the configured default (ZCodeProject).
      const workspace = args.workspace ?? DEFAULT_WORKSPACE
      return await run(session, target, workspace)
    } catch (error) {
      // A cancellation of THIS call is not a pairing failure: the socket is fine
      // and sibling tasks are still streaming over it. Neither is a UsageError
      // (a refusal or input problem): releasing the pairing for those would
      // kill every sibling task on this client.
      if (exec?.signal?.aborted || error?.message === 'aborted'
        || error instanceof UsageError || error?.constructor?.name === 'UsageError') throw error
      cache.release(target.url)
      throw new Error(`${error?.message ?? error}\n${RELEASED_NOTE}`)
    }
  }

  /**
   * Refuse when the client has no free task slot, so a dispatch is not queued on
   * the desktop where it would burn the whole wait budget.
   * @param {object} session - the client session.
   * @param {object} target - the resolved target, for labelling the refusal.
   */
  const assertHasSlot = async (session, target) => {
    // An unreadable count never blocks work.
    const runningCount = typeof session.runningTaskCount === 'function' ? await session.runningTaskCount() : null
    const refusal = capacityRefusal(runningCount, MAX_RUNNING_TASKS)
    if (refusal !== undefined) throw new UsageError(target.label ? `[${target.label}] ${refusal}` : refusal)
  }

  ctx.tools.register(defineTool({
    name: 'zcode_remote_dispatch',
    description: 'Send a task prompt to a ZCode client on another machine through its mobile remote-control relay, like the phone app does. '
      + 'The client runs the prompt as a real coding task in its workspace. '
      + 'By default this waits for the reply. Set `async: true` to return as soon as the task is accepted, then fetch the reply with '
      + 'zcode_remote_collect — use that to run several tasks at once; keep at most 2 concurrent per client '
      + '(the desktop stops running tasks beyond 3). '
      + 'Name the client with `device` (a configured name) or `url` (its link); omit both for the default. One call = one user message on the client. '
      + 'A `new_task` dispatch starts on `model` at reasoning level `thought` '
      + '(defaults: GLM-5.3-Flash, max); the result\'s `config` field reports what the desktop actually '
      + 'applied, since invalid values are silently replaced by its defaults.',
    parameters: {
      text: { type: 'string', required: true, description: 'The prompt to send to the client.' },
      session_id: { type: 'string', description: 'Target task id (sess_*). Required with `new_task: false` if the client has no active task.' },
      new_task: { type: 'boolean', description: 'Create a fresh task on the client for this prompt, instead of reusing a conversation. Default false.' },
      model: { type: 'string', description: 'Model for a `new_task` dispatch, e.g. "GLM-5.3" or "GLM-5.3-Flash". Ignored without `new_task: true`. Default: config.defaultModel (GLM-5.3-Flash).' },
      thought: { type: 'string', description: 'Reasoning level for a `new_task` dispatch: low | high | max. Ignored without `new_task: true`. Default: config.defaultThought (max).' },
      async: { type: 'boolean', description: 'Return as soon as the task is accepted, without waiting for the reply. Default false. Collect it later with zcode_remote_collect.' },
      wait_seconds: { type: 'integer', description: 'When waiting, max seconds for the reply. Default 180, max 600. Ignored with `async: true`.' },
      ...ADDRESSING_PARAMETERS,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { type: 'string' },
          sessionId: { type: 'string', required: true },
          workspacePath: { type: 'string', required: true },
          accepted: { type: 'boolean', required: true },
          pending: { type: 'boolean', required: true },
          complete: { type: 'boolean' },
          reply: { type: 'string' },
          config: { type: 'object', additionalProperties: true },
          transcript: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.pending
          ? `Task ${value.sessionId} accepted${value.device ? ` on ${value.device}` : ''}; still running — `
            + 'fetch the reply with zcode_remote_collect.'
          : `Task ${value.sessionId}${value.device ? ` on ${value.device}` : ''}`
            + `${value.complete ? ' replied' : ' has not replied yet'}:\n${value.reply ?? '(no assistant text yet)'}`
            + (value.config ? `\n(effective config: ${JSON.stringify(value.config)})` : ''),
      }],
    },
    async execute(args, exec) {
      const waitMs = Math.min(Math.max((args.wait_seconds ?? config.waitSeconds ?? 180) | 0, 5), 600) * 1000
      return onDevice(args, async (session, target, workspace) => {
        await assertHasSlot(session, target)
        const label = target.label ?? linkDeviceName(target.url)
        // new_task creates AND starts the task in one createSession command (the
        // prompt rides `firstInput.text`); a passed session_id reuses that task.
        // The model selection rides the same command, so it applies to a new
        // task only — an existing conversation keeps the model it started with.
        const handle = await session.startDispatch({
          text: args.text,
          sessionId: args.session_id,
          workspace,
          newTask: args.new_task === true,
          model: args.model ?? DEFAULT_MODEL,
          thought: args.thought ?? DEFAULT_THOUGHT,
          provider: DEFAULT_PROVIDER,
        })
        const accepted = handle.ack?.status === 'accepted'
        const base = {
          device: label,
          sessionId: handle.taskId,
          workspacePath: handle.workspacePath,
          accepted,
        }
        const result = await session.collectDispatch(handle, { waitMs, signal: exec.signal })
        if (args.async || !result.complete) {
          // The task is still working: keep its routing entry so collect can be
          // called again, and let the caller poll rather than lose the stream.
          inflight.set(dispatchKey(target.url, handle.taskId), { handle, url: target.url, label })
        }
        if (args.async) return pruneUndefined({ ...base, pending: true })
        return pruneUndefined({
          ...base,
          pending: false,
          complete: result.complete,
          reply: result.replies.length ? result.replies.join('\n\n') : undefined,
          ...(result.config ? { config: result.config } : {}),
          transcript: result.transcript.slice(-12),
        })
      }, exec)
    },
    presentCall: args => ({ card: 'generic', title: 'Dispatch to desktop ZCode', kind: 'other', rawInput: args }),
    // Dispatches to different clients are independent; same-client dispatches are
    // separated by subscription id, and the relay multiplexes them on one socket.
    isConcurrencySafe: () => true,
  }))

  ctx.tools.register(defineTool({
    name: 'zcode_remote_collect',
    description: 'Fetch the reply of a task started with zcode_remote_dispatch({ async: true }). '
      + 'Give the same `device` or `url` used to dispatch, plus the `session_id` that dispatch returned. '
      + 'Waits until the task has been silent for a moment, or until `wait_seconds` runs out. '
      + 'An unfinished task can be collected again — its stream keeps flowing until it completes, and this '
      + 'call never disturbs sibling tasks on the same client. Give one call per task. '
      + 'Works even after this plugin restarted: with no in-memory entry for the task it re-attaches by '
      + '`session_id`, subscribing to the conversation and reading it back without sending anything.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'The task id returned by an async dispatch.' },
      wait_seconds: { type: 'integer', description: 'Max seconds to wait for the reply. Default 180, max 600.' },
      ...ADDRESSING_PARAMETERS,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { type: 'string' },
          sessionId: { type: 'string', required: true },
          complete: { type: 'boolean', required: true },
          reply: { type: 'string' },
          config: { type: 'object', additionalProperties: true },
          transcript: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Task ${value.sessionId}${value.device ? ` on ${value.device}` : ''}`
          + `${value.complete ? ' replied' : ' has not replied yet'}:\n${value.reply ?? '(no assistant text yet)'}`
          + (value.config ? `\n(effective config: ${JSON.stringify(value.config)})` : ''),
      }],
    },
    async execute(args, exec) {
      const waitMs = Math.min(Math.max((args.wait_seconds ?? config.waitSeconds ?? 180) | 0, 5), 600) * 1000
      return onDevice(args, async (session, target, workspace) => {
        const label = target.label ?? linkDeviceName(target.url)
        let entry = inflight.get(dispatchKey(target.url, args.session_id))
        if (!entry) {
          // The registry is in-memory only: after a restart (or for a task whose
          // earlier collect completed) re-attach instead of failing — subscribe
          // to the conversation and read its rows back, sending nothing.
          const handle = await session.reattachDispatch(args.session_id, workspace)
          entry = { handle, url: target.url, label }
          inflight.set(dispatchKey(target.url, args.session_id), entry)
        }
        const result = await session.collectDispatch(entry.handle, { waitMs, signal: exec.signal })
        if (result.complete) inflight.delete(dispatchKey(target.url, args.session_id))
        // An unfinished task keeps its entry: call collect again for more.
        return pruneUndefined({
          device: label,
          sessionId: result.sessionId,
          complete: result.complete,
          reply: result.replies.length ? result.replies.join('\n\n') : undefined,
          ...(result.config ? { config: result.config } : {}),
          transcript: result.transcript.slice(-12),
        })
      }, exec)
    },
    isConcurrencySafe: () => true,
  }))

  ctx.tools.register(defineTool({
    name: 'zcode_remote_status',
    description: 'List one ZCode device\'s workspaces, recent tasks and how many tasks are running, through the mobile remote-control relay. '
      + 'Call it to find a target session id before zcode_remote_dispatch, or to check whether a device has a free task slot. '
      + 'Name the device with `device` or `url`; omit both for the default device.',
    parameters: { ...ADDRESSING_PARAMETERS },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          device: { type: 'string' },
          activeWorkspaceKey: { type: 'string' },
          selectedWorkspace: { type: 'string' },
          activeTaskId: { type: 'string' },
          runningCount: { type: 'integer', required: true },
          totalCount: { type: 'integer', required: true },
          runningTaskIds: { type: 'array', required: true, items: { type: 'string' } },
          scopedTotalCount: { type: 'integer' },
          workspaces: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          tasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.device ? `Device ${value.device}: ` : ''}${value.workspaces.length} workspace(s)`
          + (value.selectedWorkspace ? `, selected: ${value.selectedWorkspace}` : '')
          + `, active task: ${value.activeTaskId ?? 'none'}\n`
          // The desktop allows a bounded number of concurrently working tasks per
          // client; the count is stated against it so the caller can tell whether
          // another dispatch has room.
          + `Running tasks: ${value.runningCount} of ${MAX_RUNNING_TASKS} allowed (${value.totalCount} total)\n`
          + value.tasks.map(t => `- [${t.status}] ${t.taskId} ${t.title} (${t.workspace})`).join('\n'),
      }],
    },
    async execute(args) {
      return onDevice(args, async (session, target, workspace) =>
        pruneUndefined({
          device: target.label ?? linkDeviceName(target.url),
          ...await session.listStatus(workspace),
        }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'zcode_remote_devices',
    description: 'List the ZCode devices this plugin can reach: their configured names, which one is the default, and which already '
      + 'hold a live pairing. Needs no connection. Call it before zcode_remote_dispatch when you do not know the device name to address.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          devices: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string', required: true },
                machine: { type: 'string' },
                default: { type: 'boolean', required: true },
                paired: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.devices.length
          ? value.devices.map(d => `- ${d.label}${d.default ? ' (default)' : ''}`
            + `${d.machine ? ` — ${d.machine}` : ''}${d.paired ? ' [paired]' : ''}`).join('\n')
          : '(no devices configured; set config.remoteUrl or config.devices)',
      }],
    },
    execute() {
      const devices = config.devices ?? {}
      const configuredDefault = typeof config.device === 'string' && config.device.trim() !== ''
        ? config.device.trim()
        : null
      const localLabel = config.localDevice ? localDeviceLabel(config) : null
      const unnamedDefault = config.remoteUrl?.includes('sid=') || linkFromParts(config)
      const effectiveDefault = configuredDefault ?? (unnamedDefault ? null : localLabel)
      const paired = new Set(cache.keys())
      const rows = Object.entries(devices).map(([label, link]) => ({
        label,
        machine: linkDeviceName(link),
        default: label === effectiveDefault,
        paired: paired.has(pairingKey(link)),
      }))
      if (config.localDevice) {
        const target = resolveLocalTarget(config)
        rows.unshift({
          label: target.label,
          machine: linkDeviceName(target.url),
          default: target.label === effectiveDefault,
          paired: paired.has(pairingKey(target.url)),
        })
      }
      for (const name of Object.keys(config.localDevices ?? {})) {
        const target = resolveLocalDevice(config, name)
        rows.push({
          label: target.label,
          machine: linkDeviceName(target.url),
          default: target.label === effectiveDefault,
          paired: paired.has(pairingKey(target.url)),
        })
      }
      // The default device may be configured directly through remoteUrl rather
      // than named in `devices`, so report it as its own row.
      const defaultLink = effectiveDefault === null
        ? (config.remoteUrl?.includes('sid=') ? config.remoteUrl : linkFromParts(config))
        : undefined
      if (defaultLink) {
        rows.unshift({
          label: '(default)',
          machine: linkDeviceName(defaultLink),
          default: true,
          paired: paired.has(pairingKey(defaultLink)),
        })
      }
      return pruneUndefined({ devices: rows })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'zcode_remote_stop',
    description: 'Interrupt a running ZCode desktop task on a device (send the stop command through the remote-control relay). '
      + 'Name the device with `device` or `url`; omit both for the default device.',
    parameters: {
      session_id: { type: 'string', description: 'Target task id. Defaults to the device\'s active task.' },
      ...ADDRESSING_PARAMETERS,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stopped: { type: 'boolean', required: true },
          detail: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.stopped ? 'Stop command accepted by the desktop agent.' : `Stop failed: ${value.detail}` }],
    },
    async execute(args) {
      try {
        const ack = await onDevice(args, (session, _target, workspace) => session.stop(args.session_id, workspace))
        return pruneUndefined({ stopped: true, detail: JSON.stringify(ack ?? null) })
      } catch (error) {
        return { stopped: false, detail: String(error?.message ?? error) }
      }
    },
  }))

  ctx.logger?.info?.('zcode-remote: tools registered (dispatch/collect/status/devices/stop)')
}
