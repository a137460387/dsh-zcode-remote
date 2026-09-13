// ZCode remote-control v4 driver — reverse-engineered wire protocol of the
// ZCode mobile remote page (https://zcode.z.ai/remote/v4).
//
// Stack (bottom to top):
//   L1 relay WS   : wss://zcode.z.ai/ws, JSON envelopes {type, ...}
//   L2 app payload: {zcode_type: ...} routed inside {type:'data', payload, client_ts}
//   L3 rpc-frame  : fragmented logical messages over a workspace bridge
//   L4 channel RPC: VS Code style binary protocol ([100,id,channel,method]+args)
//   L5 services   : channel 'zcode-agent' conversation V4 API

import { createHmac, randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC32 (reflected, poly 0xEDB88320) as 8-char lowercase hex. */
export function crc32Hex(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return ((c ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0')
}

function writeVarint(list, value) {
  if (value === 0) { list.push(0); return }
  let v = value
  for (;;) {
    let byte = v & 0x7f
    v >>>= 7
    if (v > 0) byte |= 0x80
    list.push(byte)
    if (v === 0) break
  }
}

function readVarint(buf, pos) {
  let value = 0, shift = 0, p = pos
  for (;;) {
    const b = buf[p++]
    value |= (b & 0x7f) << shift
    if (!(b & 0x80)) return [value >>> 0, p]
    shift += 7
  }
}

// ---------------------------------------------------------------------------
// L4: channel RPC binary codec
// ---------------------------------------------------------------------------

const TAG = { Undefined: 0, String: 1, Buffer: 2, VSBuffer: 3, Array: 4, Object: 5, Int: 6 }

class RpcWriter {
  chunks = []
  write(value) {
    if (value === undefined) { this.chunks.push(TAG.Undefined); return }
    if (typeof value === 'string') {
      this.chunks.push(TAG.String)
      const bytes = new TextEncoder().encode(value)
      writeVarint(this.chunks, bytes.byteLength)
      for (const b of bytes) this.chunks.push(b)
      return
    }
    if (value instanceof Uint8Array) {
      this.chunks.push(TAG.Buffer)
      writeVarint(this.chunks, value.byteLength)
      for (const b of value) this.chunks.push(b)
      return
    }
    if (Array.isArray(value)) {
      this.chunks.push(TAG.Array)
      writeVarint(this.chunks, value.length)
      for (const item of value) this.write(item)
      return
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) {
      this.chunks.push(TAG.Int)
      writeVarint(this.chunks, value)
      return
    }
    this.chunks.push(TAG.Object)
    const json = new TextEncoder().encode(JSON.stringify(value))
    writeVarint(this.chunks, json.byteLength)
    for (const b of json) this.chunks.push(b)
  }
  toUint8Array() { return Uint8Array.from(this.chunks) }
}

export function encodeRpcMessage(arrayValue, trailing) {
  const w = new RpcWriter()
  w.write(arrayValue)
  if (trailing !== undefined) w.write(trailing)
  return w.toUint8Array()
}

function decodeOne(bytes, pos) {
  const tag = bytes[pos++]
  switch (tag) {
    case TAG.Undefined: return [undefined, pos]
    case TAG.String: {
      const [len, p] = readVarint(bytes, pos)
      return [new TextDecoder().decode(bytes.subarray(p, p + len)), p + len]
    }
    case TAG.Buffer:
    case TAG.VSBuffer: {
      const [len, p] = readVarint(bytes, pos)
      return [bytes.slice(p, p + len), p + len]
    }
    case TAG.Array: {
      const [count, p0] = readVarint(bytes, pos)
      let p = p0
      const arr = []
      for (let i = 0; i < count; i++) { const [v, np] = decodeOne(bytes, p); arr.push(v); p = np }
      return [arr, p]
    }
    case TAG.Int: { const [v, p] = readVarint(bytes, pos); return [v, p] }
    case TAG.Object: {
      const [len, p] = readVarint(bytes, pos)
      return [JSON.parse(new TextDecoder().decode(bytes.subarray(p, p + len))), p + len]
    }
    default: throw new Error(`unknown rpc value tag ${tag}`)
  }
}

export function decodeRpcValues(bytes) {
  const values = []
  let pos = 0
  while (pos < bytes.length) {
    const [v, np] = decodeOne(bytes, pos)
    values.push(v)
    pos = np
  }
  return values
}

// ---------------------------------------------------------------------------
// L3: rpc-frame fragmentation
// ---------------------------------------------------------------------------

const MAX_PHYSICAL_FRAME_BYTES = 1024 * 1024

export function encodeRpcFrames(messageBytes, identity, seqStart, messageSeq) {
  const checksum = { algorithm: 'crc32', value: crc32Hex(messageBytes) }
  const total = messageBytes.byteLength
  const envelopeBytes = (fragmentBytes) => {
    const probe = {
      zcode_type: 'rpc-frame',
      ...identity,
      seq: seqStart,
      messageSeq,
      fragmentIndex: 0,
      fragmentCount: 1,
      messageBytes: total,
      checksum,
      dataBase64: 'A'.repeat(Math.ceil(fragmentBytes / 3) * 4),
    }
    return new TextEncoder().encode(JSON.stringify(probe)).byteLength
  }
  let chunk = 1, hi = total
  while (chunk < hi) {
    const mid = Math.ceil((chunk + hi) / 2)
    if (envelopeBytes(mid) <= MAX_PHYSICAL_FRAME_BYTES) chunk = mid
    else hi = mid - 1
  }
  const fragmentCount = Math.max(1, Math.ceil(total / chunk))
  if (fragmentCount > 64) throw new Error('rpcFrame fragmentLimitExceeded')
  const frames = []
  for (let i = 0; i < fragmentCount; i++) {
    const start = i * chunk
    const end = Math.min(total, start + chunk)
    frames.push({
      zcode_type: 'rpc-frame',
      ...identity,
      seq: seqStart + i,
      messageSeq,
      fragmentIndex: i,
      fragmentCount,
      messageBytes: total,
      checksum,
      dataBase64: Buffer.from(messageBytes.subarray(start, end)).toString('base64'),
    })
  }
  return frames
}

export class RpcAssembler {
  expectedSeq = 1
  expectedMessageSeq = 1
  active = null

  accept(frame) {
    if (frame.seq !== this.expectedSeq || frame.messageSeq !== this.expectedMessageSeq) {
      return { kind: 'dropped', reason: `expected seq=${this.expectedSeq} messageSeq=${this.expectedMessageSeq}, got seq=${frame.seq} messageSeq=${frame.messageSeq}` }
    }
    if (frame.fragmentIndex === 0) {
      this.active = { fragments: new Array(frame.fragmentCount), received: 0, frame }
    }
    if (!this.active) return { kind: 'dropped', reason: 'no active message' }
    if (frame.fragmentCount !== this.active.fragments.length) {
      this.active = null
      return { kind: 'fault', reason: 'fragmentCount changed mid-message' }
    }
    this.active.fragments[frame.fragmentIndex] = new Uint8Array(Buffer.from(frame.dataBase64, 'base64'))
    this.active.received++
    // Physical sequence advances with EVERY frame, not only the last one.
    this.expectedSeq = frame.seq + 1
    if (this.active.received < this.active.fragments.length) return { kind: 'incomplete' }
    const total = this.active.fragments.reduce((n, f) => n + f.byteLength, 0)
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const f of this.active.fragments) { bytes.set(f, offset); offset += f.byteLength }
    if (crc32Hex(bytes) !== this.active.frame.checksum.value) {
      this.active = null
      this.expectedMessageSeq++
      return { kind: 'fault', reason: 'checksum mismatch' }
    }
    this.active = null
    const messageSeq = this.expectedMessageSeq
    this.expectedMessageSeq++
    return { kind: 'message', bytes, messageSeq }
  }
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

export class ZcodeRemoteClient {
  constructor({ url, log = () => {}, clientKind = 'web' }) {
    const parsed = new URL(url)
    this.deviceSid = parsed.searchParams.get('sid')
    this.passHash = parsed.searchParams.get('hash')
    this.deviceMid = parsed.searchParams.get('mid') ?? ''
    this.appVersion = parsed.searchParams.get('app_version') ?? 'web'
    this.deviceName = parsed.searchParams.get('name') ?? 'mobile-browser'
    if (!this.deviceSid || !this.passHash) {
      throw new Error('remoteUrl must be a zcode remote-control link containing sid and hash query parameters')
    }
    this.relayWsUrl = 'wss://zcode.z.ai/ws' + (this.deviceMid ? `?mid=${encodeURIComponent(this.deviceMid)}` : '')
    this.clientKind = clientKind
    this.log = log
    this.state = 'idle'
    this.clientId = `client-${randomUUID()}`
    this.relayWaiters = []
    this.bridgeIdentity = null
    this.outMessageSeq = 1
    this.outPhysicalSeq = 1
    this.inAssembler = null
    this.channelHandlers = new Map()
    this.eventListeners = new Map()
    this.nextRequestId = 1
    this.initialized = false
    this.initWaiters = []
    this.heartbeatTimer = null
    this.closed = false
  }

  // ----- L1 relay -----

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this
    this.closed = false
    this.ws = new WebSocket(this.relayWsUrl)
    await new Promise((resolve, reject) => {
      const onError = () => reject(new Error('relay socket error'))
      this.ws.addEventListener('open', () => { this.ws.removeEventListener('error', onError); resolve() }, { once: true })
      this.ws.addEventListener('error', onError, { once: true })
    })
    this.ws.addEventListener('message', ev => this.onRelayMessage(String(ev.data)))
    this.ws.addEventListener('close', ev => {
      this.log(`relay closed code=${ev.code} reason=${ev.reason || ''}`)
      this.stopHeartbeat()
      this.state = 'closed'
      for (const waiter of this.relayWaiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error(`relay closed while waiting (${ev.code})`))
      }
    })
    this.state = 'authenticating'
    this.sendRelay({
      type: 'auth_init',
      role: 'terminal',
      device_sid: this.deviceSid,
      meta: { platform: 'web', version: this.appVersion, name: this.deviceName },
      client_ts: Date.now(),
    })
    await this.waitForPair()
    this.startHeartbeat()
    return this
  }

  close() {
    this.closed = true
    this.stopHeartbeat()
    try { this.ws?.close() } catch {}
  }

  sendRelay(obj) {
    this.ws.send(JSON.stringify(obj))
  }

  onRelayMessage(text) {
    let msg
    try { msg = JSON.parse(text) } catch { return }
    switch (msg.type) {
      case 'auth_challenge': {
        const proof = createHmac('sha256', this.passHash)
          .update(`${msg.nonce}|terminal|${this.deviceSid}`)
          .digest('base64url')
        this.sendRelay({ type: 'auth_response', device_sid: this.deviceSid, proof, client_ts: Date.now() })
        break
      }
      case 'auth_ack':
      case 'pair_status_ack': {
        this.applyPairStatus(msg.pair_status)
        break
      }
      case 'data':
        this.onAppPayload(msg.payload)
        break
      case 'error':
        this.log(`relay error code=${msg.code} message=${msg.message ?? ''}`)
        this.lastRelayError = msg
        break
      default:
        this.log(`relay msg type=${msg.type}`)
    }
  }

  applyPairStatus(status) {
    if (status === 'matched') {
      const first = this.state !== 'paired'
      this.state = 'paired'
      if (first) this.pairResolve?.()
    } else if (status === 'waiting') {
      this.state = 'waiting'
    }
  }

  waitForPair(timeoutMs = 35000) {
    if (this.state === 'paired') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`pairing timeout (state=${this.state}, lastError=${this.lastRelayError?.code ?? 'none'})`)), timeoutMs)
      this.pairResolve = () => { clearTimeout(timer); resolve() }
    })
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendRelay({ type: 'pair_status_query', device_sid: this.deviceSid, client_ts: Date.now() })
      }
    }, 10000)
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  // ----- L2 app payloads -----

  sendPayload(payload) {
    this.sendRelay({ type: 'data', payload, client_ts: Date.now() })
  }

  /** Send an app payload and wait for a matching response payload. */
  requestAppPayload(payload, match, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve, reject }
      waiter.timer = setTimeout(() => {
        const i = this.relayWaiters.indexOf(waiter)
        if (i >= 0) this.relayWaiters.splice(i, 1)
        reject(new Error(`relay request timeout for ${payload.zcode_type}`))
      }, timeoutMs)
      this.relayWaiters.push(waiter)
      this.sendPayload(payload)
    })
  }

  onAppPayload(payload) {
    if (!payload || typeof payload !== 'object') return
    if (payload.zcode_type === 'rpc-frame' || payload.zcode_type === 'rpc-frame-ack') {
      this.onRpcFramePayload(payload)
      return
    }
    for (let i = 0; i < this.relayWaiters.length; i++) {
      const waiter = this.relayWaiters[i]
      if (waiter.match(payload)) {
        this.relayWaiters.splice(i, 1)
        clearTimeout(waiter.timer)
        waiter.resolve(payload)
        return
      }
    }
    for (const interceptor of this.interceptors ?? []) {
      if (interceptor(payload) === true) return
    }
    this.log(`unrouted app payload zcode_type=${payload.zcode_type} body=${JSON.stringify(payload).slice(0, 300)}`)
  }

  interceptPayloads(handler) {
    this.interceptors ??= new Set()
    this.interceptors.add(handler)
    return () => this.interceptors.delete(handler)
  }

  // ----- L3 rpc-frame transport -----

  attachBridge(bridge) {
    this.bridgeIdentity = {
      bridgeSessionId: bridge.bridgeSessionId,
      bridgeGeneration: bridge.bridgeGeneration,
      ...(bridge.recoveryId ? { recoveryId: bridge.recoveryId } : {}),
    }
    this.inAssembler = new RpcAssembler()
    this.outMessageSeq = 1
    this.outPhysicalSeq = 1
    this.initialized = false
    this.initWaiters = []
  }

  onRpcFramePayload(payload) {
    if (payload.zcode_type === 'rpc-frame-ack') return
    if (!this.bridgeIdentity) return
    if (payload.bridgeSessionId !== this.bridgeIdentity.bridgeSessionId) return
    const result = this.inAssembler.accept(payload)
    if (result.kind === 'message') {
      this.sendPayload({
        zcode_type: 'rpc-frame-ack',
        ...this.bridgeIdentity,
        ackMessageSeq: result.messageSeq,
      })
      this.onChannelBytes(result.bytes)
    } else if (result.kind === 'fault' || result.kind === 'dropped') {
      this.log(`rpc assembler ${result.kind}: ${result.reason}`)
    }
  }

  sendChannelMessage(bytes) {
    if (!this.bridgeIdentity) throw new Error('no bridge attached')
    const frames = encodeRpcFrames(bytes, this.bridgeIdentity, this.outPhysicalSeq, this.outMessageSeq)
    this.outMessageSeq++
    this.outPhysicalSeq += frames.length
    for (const frame of frames) this.sendPayload(frame)
  }

  // ----- L4 channel RPC -----

  onChannelBytes(bytes) {
    const values = decodeRpcValues(bytes)
    const header = values[0]
    if (!Array.isArray(header)) return
    const [type, id] = header
    const data = values[1]
    switch (type) {
      case 200:
        this.initialized = true
        for (const w of this.initWaiters.splice(0)) w()
        break
      case 201:
        this.channelHandlers.get(id)?.resolve(data)
        this.channelHandlers.delete(id)
        break
      case 202: {
        const err = new Error(data?.message ?? 'rpc error')
        err.name = data?.name ?? 'Error'
        this.channelHandlers.get(id)?.reject(err)
        this.channelHandlers.delete(id)
        break
      }
      case 203:
        this.channelHandlers.get(id)?.reject(Object.assign(new Error('rpc error object'), { raw: data }))
        this.channelHandlers.delete(id)
        break
      case 204:
        this.eventListeners.get(id)?.handler(data)
        break
      default:
        this.log(`rpc: unknown message type ${type}`)
    }
  }

  waitInitialized(timeoutMs = 30000) {
    if (this.initialized) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.initWaiters.push(resolve)
      setTimeout(() => reject(new Error('rpc Initialize timeout')), timeoutMs)
    })
  }

  async call(channel, method, args = [], timeoutMs = 30000) {
    await this.waitInitialized(timeoutMs)
    const id = this.nextRequestId++
    const bytes = encodeRpcMessage([100, id, channel, method], args)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.channelHandlers.delete(id)
        reject(new Error(`rpc call timeout ${channel}.${method}`))
      }, timeoutMs)
      this.channelHandlers.set(id, {
        resolve: v => { clearTimeout(timer); resolve(v) },
        reject: e => { clearTimeout(timer); reject(e) },
      })
      this.sendChannelMessage(bytes)
    })
  }

  listen(channel, event, handler, arg) {
    const id = this.nextRequestId++
    this.eventListeners.set(id, { event, handler })
    // onDynamic* events are workspace-scoped: arg carries {workspacePath, workspaceIdentity?}
    this.sendChannelMessage(encodeRpcMessage([102, id, channel, event], arg))
    return () => {
      this.eventListeners.delete(id)
      try { this.sendChannelMessage(encodeRpcMessage([103, id, channel, ''], undefined)) } catch {}
    }
  }

  // ----- L5 conversation flow -----

  async bootstrap() {
    const requestId = `bootstrap-${randomUUID()}`
    const res = await this.requestAppPayload(
      { zcode_type: 'bootstrap-request', requestId },
      p => p.zcode_type === 'bootstrap-response' && p.requestId === requestId,
    )
    return res.result
  }

  async listWorkspaces() {
    const requestId = `workspace-list-${randomUUID()}`
    const res = await this.requestAppPayload(
      { zcode_type: 'workspace-list-request', requestId },
      p => p.zcode_type === 'workspace-list-response' && p.requestId === requestId,
    )
    return res.result
  }

  /** Open a workspace bridge; resolves with the bridge descriptor. */
  openBridge(workspaceKey, taskId) {
    const bridgeSessionId = `bridge-${randomUUID()}`
    const requestId = `workspace-bridge-${randomUUID()}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('workspace-bridge-open timeout')) }, 45000)
      const off = this.interceptPayloads(p => {
        if (p.zcode_type === 'workspace-bridge-error') {
          clearTimeout(timer); off()
          reject(new Error(`workspace-bridge-error(${p.reason ?? 'unknown'}): ${p.error ?? ''}`.trim()))
          return
        }
        if (p.zcode_type === 'workspace-bridge-ready' && p.bridgeSessionId === bridgeSessionId) {
          clearTimeout(timer); off()
          resolve(p.bridge)
          return
        }
      })
      this.sendPayload({
        zcode_type: 'workspace-bridge-open',
        requestId,
        bridgeSessionId,
        bridgeGeneration: 1,
        workspaceKey,
        ...(taskId ? { taskId } : {}),
      })
    }).then(async bridge => {
      this.attachBridge(bridge)
      await this.waitInitialized()
      return bridge
    })
  }

  async agentHello() {
    return this.call('zcode-agent', 'helloConversationV4', [])
  }

  async agentInitialize() {
    return this.call('zcode-agent', 'initializeConversationV4', [{
      kind: 'clientHello',
      protocolVersion: 3,
      clientId: this.clientId,
      clientKind: this.clientKind,
      appVersion: 'unknown',
      capabilities: { workspaceHookReviewUi: true },
    }])
  }

  async subscribeConversation(workspacePath, sessionId) {
    return this.call('zcode-agent', 'subscribeConversationV4', [{
      workspacePath,
      sessionId,
      visibility: 'foreground',
    }], 60000)
  }

  /**
   * Release one conversation subscription, so a client holding many dispatches
   * does not accumulate them.
   * @param {string} workspacePath - the bridged workspace.
   * @param {string} subscriptionId - the id `subscribeConversationV4` returned.
   * @returns the acknowledged unsubscribe result, or undefined when unsupported.
   */
  async unsubscribeConversation(workspacePath, subscriptionId) {
    return this.call('zcode-agent', 'unsubscribeConversationV4', [{ workspacePath, subscriptionId }], 30000)
  }

  /**
   * Create a task on this client, so a dispatch has a target without reusing an
   * existing conversation.
   * @param {string} workspacePath - the bridged workspace.
   * @returns the created task's id and the raw result.
   */
  async createTask(workspacePath) {
    const raw = await this.call('zcode-session', 'createSession', [{ workspacePath }], 60000)
    const sessionId = raw?.sessionId ?? raw?.session?.id ?? raw?.session?.sessionId
      ?? raw?.result?.sessionId ?? raw?.id
    if (!sessionId) throw new Error(`createSession returned no task id: ${JSON.stringify(raw ?? null).slice(0, 300)}`)
    return { sessionId, raw }
  }

  async sendConversationCommand(workspacePath, envelope) {
    return this.call('zcode-agent', 'sendConversationCommandV4', [{ workspacePath, envelope }], 60000)
  }

  makeCommand(sessionId, type, payload) {
    return {
      commandId: randomUUID(),
      clientId: this.clientId,
      sessionId,
      type,
      payload,
      issuedAt: Date.now(),
    }
  }
}

/**
 * High-level session wrapper: connect/pair once, resolve target workspace and
 * task, bridge, subscribe, send a prompt, and collect the streamed assistant
 * reply. Reconnects with backoff when the desktop or relay drops.
 */
export class ZcodeRemoteSession {
  constructor({ url, log = () => {}, clientKind, workspacePath, sessionId }) {
    this.url = url
    this.log = log
    this.clientKind = clientKind ?? 'web'
    this.preferredWorkspacePath = workspacePath
    this.preferredSessionId = sessionId
    this.client = null
    this.bridge = null
    this.connecting = null
    // Active dispatches keyed by subscription id, plus the single listener that
    // routes frames to them. One link permits one relay connection, so every
    // concurrent task on this client shares that connection and is separated by
    // subscription id rather than by socket.
    this.dispatchHandlers = new Map()
    this.frameRouter = null
  }

  async ensureReady() {
    if (this.client && this.bridge && this.client.state === 'paired' && this.client.ws?.readyState === WebSocket.OPEN) {
      return { client: this.client, bridge: this.bridge }
    }
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      try {
        this.client?.close()
        const client = new ZcodeRemoteClient({ url: this.url, log: this.log, clientKind: this.clientKind })
        await client.connect()
        const wsList = await client.listWorkspaces()
        const wsKey = this.preferredWorkspacePath
          ?? wsList.activeWorkspaceKey
          ?? (wsList.workspaces ?? []).map(w => w.workspaceIdentity?.trim() || w.workspacePath)[0]
        if (!wsKey) throw new Error('desktop has no opened workspace')
        const bridge = await client.openBridge(wsKey, this.preferredSessionId ?? wsList.activeTaskId)
        await client.agentHello()
        await client.agentInitialize()
        this.client = client
        this.bridge = bridge
        this.activeTaskId = wsList.activeTaskId
        this.tasks = wsList.tasks ?? []
        return { client, bridge }
      } finally {
        this.connecting = null
      }
    })()
    return this.connecting
  }

  async listStatus() {
    const { client } = await this.ensureReady()
    const wsList = await client.listWorkspaces()
    const allTasks = wsList.tasks ?? []
    // `displayStatus` is the desktop's own per-task state, with `running` meaning
    // the task is actively working. Counting from the complete list (not the
    // truncated view below) is what makes the total trustworthy.
    const running = allTasks.filter(t => t.displayStatus === 'running')
    return {
      activeWorkspaceKey: wsList.activeWorkspaceKey,
      activeTaskId: wsList.activeTaskId,
      workspaces: (wsList.workspaces ?? []).map(w => ({ path: w.workspacePath, identity: w.workspaceIdentity, kind: w.kind })),
      runningCount: running.length,
      totalCount: allTasks.length,
      runningTaskIds: running.map(t => t.taskId),
      tasks: allTasks.slice(0, 20).map(t => ({
        taskId: t.taskId, title: t.title, status: t.displayStatus, workspace: t.workspacePath, updatedAt: t.updatedAt,
      })),
    }
  }

  /**
   * How many tasks the desktop currently reports as working, from the complete
   * task list rather than a truncated view.
   * @returns the number of tasks whose `displayStatus` is `running`.
   */
  async runningTaskCount() {
    return (await this.taskList()).filter(t => t.displayStatus === 'running').length
  }

  /**
   * Idle tasks on this client, which a dispatch can target directly without
   * creating anything.
   * @returns the task list entries whose `displayStatus` is not `running`.
   */
  async idleTasks() {
    return (await this.taskList()).filter(t => t.displayStatus !== 'running')
  }

  /** Every task the desktop reports for this client. */
  async taskList() {
    const { client } = await this.ensureReady()
    const wsList = await client.listWorkspaces()
    return wsList.tasks ?? []
  }

  /**
   * Create a fresh task on this client, so concurrent dispatches each get their
   * own conversation instead of queueing behind one.
   * @returns the new task's id.
   */
  async createTask() {
    const { client, bridge } = await this.ensureReady()
    const { sessionId } = await client.createTask(bridge.workspacePath)
    return sessionId
  }

  /**
   * Route inbound topic frames to the dispatch that subscribed to them.
   *
   * ONE listener serves every task on a client, because one link permits a
   * single relay connection — a second connection kicks the first (`KICKED`), so
   * concurrent tasks cannot each own a socket. Frames from all subscriptions
   * therefore arrive interleaved on this stream, and each carries the
   * `subscriptionId` its `subscribeConversationV4` returned; that id is what
   * separates task A's output from task B's.
   */
  ensureFrameRouter(client, bridge) {
    if (this.frameRouter) return
    this.frameRouter = client.listen('zcode-agent', 'onDynamicConversationFrame', event => {
      // The delivered event wraps a topic envelope
      // {wireVersion, kind, topic, subscriptionId, frame}; the conversation
      // payload is inside that envelope's `frame`. Bare payloads are accepted
      // too, so a shape change degrades to the single-dispatch path rather than
      // silently dropping every frame.
      const envelope = event?.frame ?? event
      const frame = envelope?.frame ?? envelope
      const payload = frame?.payload
      if (!payload) return
      const subscriptionId = envelope?.subscriptionId
      let handle = subscriptionId ? this.dispatchHandlers.get(subscriptionId) : undefined
      if (!handle) {
        const active = [...this.dispatchHandlers.values()]
        // With exactly one dispatch in flight there is nothing to confuse, so an
        // unlabelled frame can only belong to it. With several, delivering to a
        // guess would splice one task's output into another's reply — dropping
        // it fails visibly instead.
        if (active.length === 1) handle = active[0]
        else {
          if (active.length > 1) {
            this.log(`dropped conversation frame: subscriptionId=${subscriptionId ?? '(none)'} matches no of ${active.length} active dispatches`)
          }
          return
        }
      }
      this.absorbInto(handle, payload)
    }, {
      workspacePath: bridge.workspacePath,
      ...(bridge.workspaceIdentity ? { workspaceIdentity: bridge.workspaceIdentity } : {}),
    })
  }

  /** Fold one conversation payload into a dispatch's row set. */
  absorbInto(handle, payload) {
    // Payloads are {kind:'snapshot', snapshot:{rows:{window:[row…]}}} or
    // {kind:'deltas', deltas:[{rowId, append} | {row}]}.
    if (payload.kind === 'snapshot' && Array.isArray(payload.snapshot?.rows?.window)) {
      for (const row of payload.snapshot.rows.window) {
        if (!row || typeof row !== 'object') continue
        const prev = handle.rows.get(row.rowId)
        if (!prev || prev.text !== row.text || prev.state !== row.state) {
          handle.rows.set(row.rowId, { ...row })
          handle.lastChange = Date.now()
        }
      }
      return
    }
    if (payload.kind === 'deltas' && Array.isArray(payload.deltas)) {
      for (const d of payload.deltas) {
        if (!d || typeof d !== 'object') continue
        if (typeof d.append === 'string' && d.rowId != null) {
          const prev = handle.rows.get(d.rowId) ?? { rowId: d.rowId, kind: d.rowKind ?? 'assistantText', text: '' }
          handle.rows.set(d.rowId, { ...prev, text: (prev.text ?? '') + d.append })
          handle.lastChange = Date.now()
        } else if (d.row && d.row.rowId != null) {
          handle.rows.set(d.row.rowId, { ...d.row })
          handle.lastChange = Date.now()
        }
      }
    }
  }

  /** The completed assistant rows this dispatch produced, in row order. */
  replyRows(handle) {
    const out = []
    for (const [id, row] of handle.rows) {
      if (handle.before?.has(id)) continue
      if (row.kind !== 'assistantText') continue
      if (typeof row.text === 'string' && row.text.trim()) out.push(row)
    }
    return out
  }

  /** Re-subscribe one dispatch, to recover frames missed while disconnected. */
  async resubscribe(handle) {
    const { client, bridge } = await this.ensureReady()
    const sub = await client.subscribeConversation(bridge.workspacePath, handle.taskId)
    const nextId = sub?.ack?.subscriptionId
    // The desktop issues a new subscription id; move the handler so the
    // refreshed stream keeps landing on this dispatch.
    if (nextId && nextId !== handle.subscriptionId) {
      this.dispatchHandlers.delete(handle.key)
      handle.subscriptionId = nextId
      handle.key = nextId
      this.dispatchHandlers.set(handle.key, handle)
    }
  }

  /**
   * Subscribe to a task and send one prompt, returning as soon as the desktop
   * accepts it. The reply is collected later with {@link collectDispatch}, so a
   * caller can run several tasks on one client concurrently.
   *
   * The subscription is registered BEFORE the prompt is sent: a reply frame that
   * arrives before its routing entry exists would be dropped.
   * @param {{ text: string, sessionId?: string }} request - prompt and target task.
   * @returns the dispatch handle to pass to {@link collectDispatch}.
   */
  async startDispatch({ text, sessionId }) {
    const { client, bridge } = await this.ensureReady()
    const target = sessionId ?? this.preferredSessionId ?? this.activeTaskId
    if (!target) throw new Error('no target task; pass sessionId')
    this.ensureFrameRouter(client, bridge)

    const sub = await client.subscribeConversation(bridge.workspacePath, target)
    const subscriptionId = sub?.ack?.subscriptionId ?? null
    const handle = {
      taskId: target,
      subscriptionId,
      key: subscriptionId ?? `session:${target}`,
      workspacePath: bridge.workspacePath,
      rows: new Map(),
      before: new Set(),
      lastChange: Date.now(),
      startedAt: Date.now(),
      settled: false,
    }
    this.dispatchHandlers.set(handle.key, handle)
    // Let the initial snapshot land first, so rows that already existed are not
    // mistaken for this prompt's reply.
    await new Promise(r => setTimeout(r, 2500))
    handle.before = new Set(handle.rows.keys())
    handle.ack = await client.sendConversationCommand(
      bridge.workspacePath,
      client.makeCommand(target, 'sendText', { text }),
    )
    handle.lastChange = Date.now()
    return handle
  }

  /**
   * Wait for one dispatch's reply. A task is COMPLETE once it has produced at
   * least one reply AND then stayed silent for 12 s; `waitMs` is only a budget,
   * so an exhausted budget with no reply leaves the task unfinished (and still
   * subscribed, for a later collect). Only a complete task releases its
   * subscription.
   * @param {object} handle - a handle from {@link startDispatch}.
   * @param {{ waitMs?: number, signal?: AbortSignal }} [options] - wait budget and cancellation.
   * @returns the collected replies and transcript for that task only.
   */
  async collectDispatch(handle, { waitMs = 180000, signal } = {}) {
    const QUIET_MS = 12000
    const start = Date.now()
    let refreshedAt = Date.now()
    let settled = false
    while (Date.now() - start < waitMs) {
      if (signal?.aborted) throw new Error('aborted')
      const hasReply = this.replyRows(handle).length > 0
      const quietFor = Date.now() - handle.lastChange
      if (hasReply && quietFor >= QUIET_MS) { settled = true; break }
      await new Promise(r => setTimeout(r, 1500))
      // Safety net: periodically re-subscribe for a fresh snapshot in case delta
      // frames were missed or malformed.
      if (Date.now() - refreshedAt > 30000) {
        refreshedAt = Date.now()
        try { await this.resubscribe(handle) } catch { /* the next poll retries */ }
      }
    }
    const transcript = []
    for (const [id, row] of handle.rows) {
      if (handle.before?.has(id)) continue
      transcript.push({ kind: row.kind, state: row.state, text: typeof row.text === 'string' ? row.text : undefined })
    }
    const replies = this.replyRows(handle).map(r => r.text)
    const result = {
      sessionId: handle.taskId,
      workspacePath: handle.workspacePath,
      ack: handle.ack,
      replies,
      transcript,
      complete: settled,
    }
    // A finished task is released: nothing more arrives for it. An unfinished
    // one KEEPS its subscription, so collect can simply be called again — a long
    // task must not lose its stream because one wait budget expired.
    if (settled) await this.releaseDispatch(handle)
    return result
  }

  /**
   * Drop one dispatch entirely: its routing entry and its subscription.
   * @param {object} handle - a handle from {@link startDispatch}.
   */
  async releaseDispatch(handle) {
    if (this.dispatchHandlers.get(handle.key) === handle) this.dispatchHandlers.delete(handle.key)
    if (handle.subscriptionId) {
      try {
        const { client, bridge } = await this.ensureReady()
        await client.unsubscribeConversation(bridge.workspacePath, handle.subscriptionId)
      } catch (error) {
        this.log(`unsubscribe failed for ${handle.subscriptionId}: ${error?.message ?? error}`)
      }
    }
  }

  /**
   * Send a prompt and wait for its reply in one step.
   * @param {{ text: string, sessionId?: string, waitMs?: number, signal?: AbortSignal }} request - prompt, target, and budget.
   * @returns the collected replies for that task.
   */
  async dispatch({ text, sessionId, waitMs = 180000, signal }) {
    const handle = await this.startDispatch({ text, sessionId })
    return this.collectDispatch(handle, { waitMs, signal })
  }

  async stop(sessionId) {
    const { client, bridge } = await this.ensureReady()
    const target = sessionId ?? this.preferredSessionId ?? this.activeTaskId
    return client.sendConversationCommand(bridge.workspacePath, client.makeCommand(target, 'stop', {}))
  }

  dispose() {
    this.client?.close()
    this.client = null
    this.bridge = null
  }
}
