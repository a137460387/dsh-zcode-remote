/**
 * dsh plugin: drive the ZCode desktop agent through the mobile remote-control
 * relay, exactly like the phone client does. Registers three agent tools:
 *
 *   zcode_remote_dispatch — send a prompt to a desktop task, wait for and
 *                           return the streamed assistant reply.
 *   zcode_remote_status   — list desktop workspaces and recent tasks.
 *   zcode_remote_stop     — interrupt a running desktop task.
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
    .description('Full zcode remote-control link (the one the mobile app opens), carrying sid, hash, t and mid query parameters.'),
  remoteSid: z.string().description('The sid query parameter of the remote link (alternative to remoteUrl).'),
  remoteHash: z.string().description('The hash query parameter of the remote link (alternative to remoteUrl).'),
  remoteMid: z.string().description('The mid query parameter of the remote link.'),
  remoteName: z.string().description('The name query parameter of the remote link.'),
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

/**
 * Normalize one remote link: accept a raw link, or build one from bare
 * `sid`/`hash`. An explicit `override` (a link passed to a tool call) wins over
 * the configured one, so an expired link can be replaced without editing the
 * profile.
 * @param {Record<string, any>} config - validated plugin config.
 * @param {string} [override] - remote link supplied at call time.
 * @returns {string} the link the driver should pair with.
 * @throws when a call-time link is present but malformed, or no link exists at all.
 */
export function normalizeRemoteUrl(config, override) {
  // A supplied-but-malformed link fails loud: silently falling back to the
  // configured link would keep using an expired one while appearing to honour
  // the new input.
  if (typeof override === 'string' && override.trim() !== '') {
    if (!override.includes('sid=')) {
      throw new Error('zcode-remote: the `url` argument is not a ZCode remote-control link '
        + '(it must contain `sid=` and `hash=`). Copy the full link from the ZCode desktop app under Remote Control.')
    }
    return override
  }
  if (config.remoteUrl?.includes('sid=')) return config.remoteUrl
  if (config.remoteSid && config.remoteHash) {
    const params = new URLSearchParams({ sid: config.remoteSid, hash: config.remoteHash, t: String(Date.now()) })
    if (config.remoteMid) params.set('mid', config.remoteMid)
    if (config.remoteName) params.set('name', config.remoteName)
    return `https://zcode.z.ai/remote/v4?${params.toString()}`
  }
  throw new Error('zcode-remote: no remote link. Pass `url` to this tool, or set config.remoteUrl in the profile patch layer '
    + '(<profile>/cordis.patch.yml). The link is shown by the ZCode desktop app under Remote Control.')
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

/**
 * Register the remote-control tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - cordis context.
 * @param {Record<string, any>} config - validated plugin config.
 */
export function apply(ctx, config) {
  const MAX_RUNNING_TASKS = config.maxRunningTasks ?? 3
  // The session is created lazily so a profile boots cleanly even before the
  // user has pasted their remote link; tools fail with a helpful error then.
  // One session per link: passing a different `url` retires the old one, which
  // is how an expired link gets replaced without a profile restart.
  let session = null
  let sessionUrl = null
  const getSession = (override) => {
    const url = normalizeRemoteUrl(config, override)
    if (session && sessionUrl !== url) {
      session.dispose()
      session = null
    }
    if (!session) {
      session = new ZcodeRemoteSession({
        url,
        clientKind: config.clientKind ?? 'web',
        workspacePath: config.workspacePath,
        sessionId: config.sessionId,
        log: (...parts) => ctx.logger?.debug?.(['zcode-remote', ...parts].join(' ')),
      })
      sessionUrl = url
    }
    return session
  }
  ctx.effect(() => () => session?.dispose(), 'zcode-remote: dispose')

  /** Released before each call so one stale pairing cannot fail a whole session. */
  const releaseSession = () => {
    session?.dispose()
    session = null
    sessionUrl = null
  }

  ctx.tools.register(defineTool({
    name: 'zcode_remote_dispatch',
    description: 'Send a task prompt to the ZCode desktop agent (another machine) through its mobile remote-control relay, like the phone app does. '
      + 'The desktop agent runs the prompt as a real coding task in its workspace and the streamed assistant reply is returned here. '
      + 'Use it when the user asks to drive/control the desktop ZCode remotely. One call = one user message on the desktop side.',
    parameters: {
      text: { type: 'string', required: true, description: 'The prompt to send to the desktop agent.' },
      session_id: { type: 'string', description: 'Target task id (sess_*). Defaults to the desktop currently active task.' },
      wait_seconds: { type: 'integer', description: 'Max seconds to wait for the reply. Default 180, max 600.' },
      url: {
        type: 'string',
        description: 'A fresh ZCode remote-control link, when the configured one has expired. '
          + 'Overrides config.remoteUrl for this and later calls; get it from the ZCode desktop app (Remote Control).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          workspacePath: { type: 'string', required: true },
          complete: { type: 'boolean', required: true },
          reply: { type: 'string' },
          transcript: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Desktop task ${value.sessionId}${value.complete ? ' replied' : ' has not replied yet'}:\n${value.reply ?? '(no assistant text yet)'}`,
      }],
    },
    async execute(args, exec) {
      const waitMs = Math.min(Math.max((args.wait_seconds ?? config.waitSeconds ?? 180) | 0, 5), 600) * 1000
      // Resolve the link before the try: a bad link is an input error, and
      // reporting it as a released pairing would misdescribe what happened.
      const link = normalizeRemoteUrl(config, args.url)
      const session = getSession(link)
      // A client allows only a bounded number of concurrently working tasks
      // (MAX_RUNNING_TASKS). Check capacity BEFORE dispatching: a full client
      // queues on the desktop, which would burn the whole wait budget and look
      // like an unresponsive agent. This runs outside the dispatch try because a
      // full client is not a pairing failure and must not release the session.
      let runningCount = null
      try {
        runningCount = typeof session.runningTaskCount === 'function' ? await session.runningTaskCount() : null
      } catch (error) {
        // Reading the count does pair, so this really is a connection failure.
        releaseSession()
        throw new Error(`${error?.message ?? error}\n`
          + '(the previous pairing was released; if this was a link expiry, pass `url` with a fresh link)')
      }
      const refusal = capacityRefusal(runningCount, MAX_RUNNING_TASKS)
      if (refusal !== undefined) throw new Error(refusal)
      let result
      try {
        result = await session.dispatch({
          text: args.text,
          sessionId: args.session_id,
          waitMs,
          signal: exec.signal,
        })
      } catch (error) {
        // A pairing or bridge failure is almost always a stale link or a stale
        // socket. Drop the session so the next call reconnects from scratch
        // instead of replaying the same dead connection.
        releaseSession()
        throw new Error(`${error?.message ?? error}\n`
          + '(the previous pairing was released; if this was a link expiry, pass `url` with a fresh link)')
      }
      return {
        sessionId: result.sessionId,
        workspacePath: result.workspacePath,
        complete: result.complete,
        reply: result.replies.length ? result.replies.join('\n\n') : undefined,
        transcript: result.transcript.slice(-12),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Dispatch to desktop ZCode', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'zcode_remote_status',
    description: 'List the desktop ZCode workspaces and recent tasks (id, title, status) through the mobile remote-control relay. '
      + 'Call it to find a target session id before zcode_remote_dispatch.',
    parameters: {
      url: {
        type: 'string',
        description: 'A fresh ZCode remote-control link, when the configured one has expired. '
          + 'Overrides config.remoteUrl for this and later calls; get it from the ZCode desktop app (Remote Control).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
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
        text: `Desktop workspaces: ${value.workspaces.length}, active task: ${value.activeTaskId ?? 'none'}\n`
          // The desktop allows a bounded number of concurrently working tasks per
          // client; the count is stated against it so the caller can tell whether
          // another dispatch has room.
          + `Running tasks: ${value.runningCount} of ${MAX_RUNNING_TASKS} allowed (${value.totalCount} total)\n`
          + value.tasks.map(t => `- [${t.status}] ${t.taskId} ${t.title} (${t.workspace})`).join('\n'),
      }],
    },
    async execute(args) {
      const link = normalizeRemoteUrl(config, args.url)
      try {
        return await getSession(link).listStatus()
      } catch (error) {
        releaseSession()
        throw new Error(`${error?.message ?? error}\n`
          + '(the previous pairing was released; if this was a link expiry, pass `url` with a fresh link)')
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'zcode_remote_stop',
    description: 'Interrupt the running ZCode desktop task (send the stop command through the remote-control relay).',
    parameters: {
      session_id: { type: 'string', description: 'Target task id. Defaults to the active task.' },
      url: {
        type: 'string',
        description: 'A fresh ZCode remote-control link, when the configured one has expired. '
          + 'Overrides config.remoteUrl for this and later calls; get it from the ZCode desktop app (Remote Control).',
      },
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
      const link = normalizeRemoteUrl(config, args.url)
      try {
        const ack = await getSession(link).stop(args.session_id)
        return { stopped: true, detail: JSON.stringify(ack ?? null) }
      } catch (error) {
        releaseSession()
        return { stopped: false, detail: String(error?.message ?? error) }
      }
    },
  }))

  ctx.logger?.info?.('zcode-remote: tools registered (dispatch/status/stop)')
}
