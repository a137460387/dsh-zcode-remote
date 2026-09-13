/**
 * dsh plugin: drive ZCode desktop agents through the mobile remote-control
 * relay, exactly like the phone client does. Registers four agent tools:
 *
 *   zcode_remote_dispatch — send a prompt to a desktop task, wait for and
 *                           return the streamed assistant reply.
 *   zcode_remote_status   — list a device's workspaces, tasks and running count.
 *   zcode_remote_devices  — list the devices this plugin can reach.
 *   zcode_remote_stop     — interrupt a running desktop task.
 *
 * One link identifies one device pairing, so a link passed to a tool call
 * selects WHICH device to act on; each device keeps its own live session, and
 * addressing device B never disturbs device A.
 *
 * @module dsh-zcode-remote
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
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
  maxRunningTasks: z.number()
    .description('Concurrently working tasks one ZCode client allows. Reported alongside the observed '
      + 'count so a caller can tell whether another dispatch has room. Defaults to 3, the documented '
      + 'limit for one remote-control link.'),
  clientKind: z.string()
    .description('clientKind announced in initializeConversationV4: web | mobileRemote | mobileApp | desktop.'),
  workspacePath: z.string().description('Pin the desktop workspace to bridge. Defaults to the desktop active workspace.'),
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

/** Assert one value is a remote-control link. The `hash` is the credential. */
function assertLink(candidate, what) {
  if (typeof candidate !== 'string' || !candidate.includes('sid=')) {
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

/**
 * Resolve which device a tool call targets, so a call may name a device by its
 * short configured name, pass a link directly, or fall back to the default.
 * @param {Record<string, any>} config - validated plugin config.
 * @param {{ device?: string, url?: string }} [args] - the call's addressing arguments.
 * @returns {{ url: string, label: string | null }} the link to pair with and the device name it came from.
 * @throws when a named device is unknown, a supplied link is malformed, or no device is configured.
 */
export function resolveTarget(config, args = {}) {
  const devices = config.devices ?? {}
  const labels = Object.keys(devices)

  if (typeof args.device === 'string' && args.device.trim() !== '') {
    const wanted = args.device.trim()
    const configured = devices[wanted]
    if (configured === undefined) {
      throw new Error(`zcode-remote: unknown device "${wanted}". Configured devices: `
        + (labels.length ? labels.join(', ') : '(none; add them under config.devices)'))
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
    const configured = devices[wanted]
    if (configured === undefined) {
      throw new Error(`zcode-remote: config.device "${wanted}" is not a key of config.devices`
        + (labels.length ? ` (known: ${labels.join(', ')})` : ' (config.devices is empty)'))
    }
    return { url: assertLink(configured, `config.devices.${wanted}`), label: wanted }
  }

  if (config.remoteUrl?.includes('sid=')) return { url: config.remoteUrl, label: null }
  const built = linkFromParts(config)
  if (built) return { url: built, label: null }

  throw new Error('zcode-remote: no device configured. Set config.remoteUrl (or config.devices), '
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
    /** The live session for `url`, created on first use. A different link under the same sid replaces it. */
    acquire(url) {
      const key = pairingKey(url)
      const existing = entries.get(key)
      if (existing?.url === url) return existing.session
      if (existing) existing.session.dispose?.()
      const session = create(url)
      entries.set(key, { url, session })
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
}

/** The message appended when a call fails, so the caller knows what to try next. */
const RELEASED_NOTE = '(only that client\'s pairing was released; other clients stay connected. '
  + 'If its link expired, get a fresh link from that client\'s ZCode desktop app.)'

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
  const MAX_RUNNING_TASKS = config.maxRunningTasks ?? 3
  // Sessions are created lazily so a profile boots cleanly even before any link
  // is configured; the tools explain what to pass instead.
  const cache = createSessionCache(url => new ZcodeRemoteSession({
    url,
    clientKind: config.clientKind ?? 'web',
    workspacePath: config.workspacePath,
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
      return await run(session, target)
    } catch (error) {
      // A cancellation of THIS call is not a pairing failure: the socket is fine
      // and sibling tasks are still streaming over it.
      if (exec?.signal?.aborted || error?.message === 'aborted') throw error
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
    if (refusal !== undefined) throw new Error(target.label ? `[${target.label}] ${refusal}` : refusal)
  }

  ctx.tools.register(defineTool({
    name: 'zcode_remote_dispatch',
    description: 'Send a task prompt to a ZCode client on another machine through its mobile remote-control relay, like the phone app does. '
      + 'The client runs the prompt as a real coding task in its workspace. '
      + 'By default this waits for the reply. Set `async: true` to return as soon as the task is accepted, then fetch the reply with '
      + 'zcode_remote_collect — use that to run several tasks at once, since one client serves up to 3 concurrently. '
      + 'Name the client with `device` (a configured name) or `url` (its link); omit both for the default. One call = one user message on the client.',
    parameters: {
      text: { type: 'string', required: true, description: 'The prompt to send to the client.' },
      session_id: { type: 'string', description: 'Target task id (sess_*). Required with `new_task: false` if the client has no active task.' },
      new_task: { type: 'boolean', description: 'Create a fresh task on the client for this prompt, instead of reusing a conversation. Default false.' },
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
          transcript: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.pending
          ? `Task ${value.sessionId} accepted${value.device ? ` on ${value.device}` : ''}; still running — `
            + 'fetch the reply with zcode_remote_collect.'
          : `Task ${value.sessionId}${value.device ? ` on ${value.device}` : ''}`
            + `${value.complete ? ' replied' : ' has not replied yet'}:\n${value.reply ?? '(no assistant text yet)'}`,
      }],
    },
    async execute(args, exec) {
      const waitMs = Math.min(Math.max((args.wait_seconds ?? config.waitSeconds ?? 180) | 0, 5), 600) * 1000
      return onDevice(args, async (session, target) => {
        await assertHasSlot(session, target)
        const label = target.label ?? linkDeviceName(target.url)
        let taskId = args.session_id
        if (args.new_task) taskId = await session.createTask()
        const handle = await session.startDispatch({ text: args.text, sessionId: taskId })
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
        if (args.async) return { ...base, pending: true }
        return {
          ...base,
          pending: false,
          complete: result.complete,
          reply: result.replies.length ? result.replies.join('\n\n') : undefined,
          transcript: result.transcript.slice(-12),
        }
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
      + 'call never disturbs sibling tasks on the same client. Give one call per task.',
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
          transcript: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Task ${value.sessionId}${value.device ? ` on ${value.device}` : ''}`
          + `${value.complete ? ' replied' : ' has not replied yet'}:\n${value.reply ?? '(no assistant text yet)'}`,
      }],
    },
    async execute(args, exec) {
      const waitMs = Math.min(Math.max((args.wait_seconds ?? config.waitSeconds ?? 180) | 0, 5), 600) * 1000
      return onDevice(args, async (session, target) => {
        const label = target.label ?? linkDeviceName(target.url)
        const entry = inflight.get(dispatchKey(target.url, args.session_id))
        if (!entry) {
          throw new Error(`no in-flight dispatch for task ${args.session_id} on ${label ?? target.url}. `
            + 'It finished on an earlier collect, was dispatched without `async: true` and completed, '
            + 'or started before this plugin restarted.')
        }
        const result = await session.collectDispatch(entry.handle, { waitMs, signal: exec.signal })
        if (result.complete) inflight.delete(dispatchKey(target.url, args.session_id))
        // An unfinished task keeps its entry: call collect again for more.
        return {
          device: label,
          sessionId: result.sessionId,
          complete: result.complete,
          reply: result.replies.length ? result.replies.join('\n\n') : undefined,
          transcript: result.transcript.slice(-12),
        }
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
          activeTaskId: { type: 'string' },
          runningCount: { type: 'integer', required: true },
          totalCount: { type: 'integer', required: true },
          runningTaskIds: { type: 'array', required: true, items: { type: 'string' } },
          workspaces: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          tasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.device ? `Device ${value.device}: ` : ''}${value.workspaces.length} workspace(s), `
          + `active task: ${value.activeTaskId ?? 'none'}\n`
          // The desktop allows a bounded number of concurrently working tasks per
          // client; the count is stated against it so the caller can tell whether
          // another dispatch has room.
          + `Running tasks: ${value.runningCount} of ${MAX_RUNNING_TASKS} allowed (${value.totalCount} total)\n`
          + value.tasks.map(t => `- [${t.status}] ${t.taskId} ${t.title} (${t.workspace})`).join('\n'),
      }],
    },
    async execute(args) {
      return onDevice(args, async (session, target) => ({
        device: target.label ?? linkDeviceName(target.url),
        ...await session.listStatus(),
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
      const defaultLabel = typeof config.device === 'string' && config.device.trim() !== ''
        ? config.device.trim()
        : null
      const paired = new Set(cache.keys())
      const rows = Object.entries(devices).map(([label, link]) => ({
        label,
        machine: linkDeviceName(link),
        default: label === defaultLabel,
        paired: paired.has(pairingKey(link)),
      }))
      // The default device may be configured directly through remoteUrl rather
      // than named in `devices`, so report it as its own row.
      const defaultLink = defaultLabel === null
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
      return { devices: rows }
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
        const ack = await onDevice(args, (session) => session.stop(args.session_id))
        return { stopped: true, detail: JSON.stringify(ack ?? null) }
      } catch (error) {
        return { stopped: false, detail: String(error?.message ?? error) }
      }
    },
  }))

  ctx.logger?.info?.('zcode-remote: tools registered (dispatch/status/devices/stop)')
}
