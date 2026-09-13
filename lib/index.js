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
  clientKind: z.string()
    .description('clientKind announced in initializeConversationV4: web | mobileRemote | mobileApp | desktop.'),
  workspacePath: z.string().description('Pin the desktop workspace to bridge. Defaults to the desktop active workspace.'),
  sessionId: z.string().description('Pin the default target task id (sess_*). Defaults to the desktop active task.'),
  waitSeconds: z.number().description('Default cap for waiting a reply after dispatch.'),
})

/** Normalize one remote link: accept the raw link or bare `sid`/`hash` pair. */
function normalizeRemoteUrl(config) {
  if (config.remoteUrl?.includes('sid=')) return config.remoteUrl
  if (config.remoteSid && config.remoteHash) {
    const params = new URLSearchParams({ sid: config.remoteSid, hash: config.remoteHash, t: String(Date.now()) })
    if (config.remoteMid) params.set('mid', config.remoteMid)
    if (config.remoteName) params.set('name', config.remoteName)
    return `https://zcode.z.ai/remote/v4?${params.toString()}`
  }
  throw new Error('zcode-remote: config.remoteUrl (or remoteSid + remoteHash) is required')
}

/**
 * Register the remote-control tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - cordis context.
 * @param {Record<string, any>} config - validated plugin config.
 */
export function apply(ctx, config) {
  // The session is created lazily so a profile boots cleanly even before the
  // user has pasted their remote link; tools fail with a helpful error then.
  let session = null
  const getSession = () => {
    if (!session) {
      session = new ZcodeRemoteSession({
        url: normalizeRemoteUrl(config),
        clientKind: config.clientKind ?? 'web',
        workspacePath: config.workspacePath,
        sessionId: config.sessionId,
        log: (...parts) => ctx.logger?.debug?.(['zcode-remote', ...parts].join(' ')),
      })
    }
    return session
  }
  ctx.effect(() => () => session?.dispose(), 'zcode-remote: dispose')

  ctx.tools.register(defineTool({
    name: 'zcode_remote_dispatch',
    description: 'Send a task prompt to the ZCode desktop agent (another machine) through its mobile remote-control relay, like the phone app does. '
      + 'The desktop agent runs the prompt as a real coding task in its workspace and the streamed assistant reply is returned here. '
      + 'Use it when the user asks to drive/control the desktop ZCode remotely. One call = one user message on the desktop side.',
    parameters: {
      text: { type: 'string', required: true, description: 'The prompt to send to the desktop agent.' },
      session_id: { type: 'string', description: 'Target task id (sess_*). Defaults to the desktop currently active task.' },
      wait_seconds: { type: 'integer', description: 'Max seconds to wait for the reply. Default 180, max 600.' },
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
      const result = await getSession().dispatch({
        text: args.text,
        sessionId: args.session_id,
        waitMs,
        signal: exec.signal,
      })
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
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          activeWorkspaceKey: { type: 'string' },
          activeTaskId: { type: 'string' },
          workspaces: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
          tasks: { type: 'array', required: true, items: { type: 'object', additionalProperties: true } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Desktop workspaces: ${value.workspaces.length}, active task: ${value.activeTaskId ?? 'none'}\n`
          + value.tasks.map(t => `- [${t.status}] ${t.taskId} ${t.title} (${t.workspace})`).join('\n'),
      }],
    },
    async execute() {
      return getSession().listStatus()
    },
  }))

  ctx.tools.register(defineTool({
    name: 'zcode_remote_stop',
    description: 'Interrupt the running ZCode desktop task (send the stop command through the remote-control relay).',
    parameters: {
      session_id: { type: 'string', description: 'Target task id. Defaults to the active task.' },
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
        const ack = await getSession().stop(args.session_id)
        return { stopped: true, detail: JSON.stringify(ack ?? null) }
      } catch (error) {
        return { stopped: false, detail: String(error?.message ?? error) }
      }
    },
  }))

  ctx.logger?.info?.('zcode-remote: tools registered (dispatch/status/stop)')
}
