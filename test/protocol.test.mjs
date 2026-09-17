import { crc32Hex, encodeRpcMessage, decodeRpcValues, encodeRpcFrames, RpcAssembler } from '../lib/zcode-remote-client.js'

const assert = (name, ok) => console.log(ok ? `PASS ${name}` : `FAIL ${name}`)

const v = crc32Hex(new TextEncoder().encode('123456789'))
assert('crc32 check vector', v === 'cbf43926')

const args = [{ workspacePath: 'D:\\x', envelope: { a: 1, b: ['x', 2, null] } }]
const msg = encodeRpcMessage([100, 7, 'zcode-agent', 'sendConversationCommandV4'], args)
const identity = { bridgeSessionId: 'bridge-t', bridgeGeneration: 1 }
const frames = encodeRpcFrames(msg, identity, 1, 1)
const asm = new RpcAssembler()
let out = null
for (const f of frames) {
  const r = asm.accept(f)
  if (r.kind === 'message') out = r
}
assert(`frag round trip (${frames.length} frame(s))`, out && Buffer.compare(Buffer.from(out.bytes), Buffer.from(msg)) === 0)
const vals = decodeRpcValues(out.bytes)
assert('header decode', JSON.stringify(vals[0]) === JSON.stringify([100, 7, 'zcode-agent', 'sendConversationCommandV4']))
assert('args decode', JSON.stringify(vals[1]) === JSON.stringify(args))

// large message forcing multi-fragment assembly
const big = encodeRpcMessage([204, 9, 'x'], [{ rows: Array.from({ length: 5000 }, (_, i) => ({ rowId: i, kind: 'assistantText', text: '字'.repeat(200) })) }])
const frames2 = encodeRpcFrames(big, identity, 1, 1)
const asm2 = new RpcAssembler()
let out2 = null
for (const f of frames2) {
  const r = asm2.accept(f)
  if (r.kind === 'message') out2 = r
}
assert(`multi-fragment round trip (${frames2.length} frames)`, out2 && Buffer.compare(Buffer.from(out2.bytes), Buffer.from(big)) === 0)

// out-of-order: a tail frame ahead of expected evidence loss, so the assembler
// resynchronizes to the sender's position instead of dropping forever.
const asm3 = new RpcAssembler()
const r3 = asm3.accept({ ...frames2[frames2.length - 1] })
assert('tail frame without head triggers resync', r3.kind === 'resync')
assert('resync adopts the sender sequence', asm3.expectedSeq === frames2[frames2.length - 1].seq
  && asm3.expectedMessageSeq === frames2[frames2.length - 1].messageSeq)

// A backwards duplicate is still dropped without advancing, and after one
// resync the channel assembles the sender's NEXT message correctly.
const asm4 = new RpcAssembler()
const before = asm4.accept({ ...frames2[1], seq: 5, messageSeq: 2 }) // ahead: resync
const dup = asm4.accept({ ...frames2[0], seq: 1, messageSeq: 1 })      // behind: dropped
assert('a stale frame after resync is dropped, not another resync',
  before.kind === 'resync' && dup.kind === 'dropped')
const asm5 = new RpcAssembler()
asm5.accept({ ...frames2[frames2.length - 1], seq: 9, messageSeq: 4 }) // resync anchor
const fresh = encodeRpcFrames(encodeRpcMessage([200, 1, 'c'], []), identity, 9, 4)
let recovered = null
for (const f of fresh) {
  const r = asm5.accept(f)
  if (r.kind === 'message') recovered = r
}
assert('the channel assembles the first message after a resync',
  recovered && JSON.stringify(decodeRpcValues(recovered.bytes)[0]) === JSON.stringify([200, 1, 'c']))

// The same mismatch twice in a row (sender re-anchoring) also resyncs.
const asm6 = new RpcAssembler()
const odd = { ...frames2[0], seq: 0, messageSeq: 0 }
assert('a first stale frame is dropped', asm6.accept(odd).kind === 'dropped')
assert('the identical mismatch repeated resyncs', asm6.accept(odd).kind === 'resync')

// socket close rejects in-flight RPC calls immediately, not at their timeout
const { ZcodeRemoteClient } = await import('../lib/zcode-remote-client.js')
{
  const client = new ZcodeRemoteClient({ url: 'https://zcode.z.ai/remote/v4?sid=S&hash=H' })
  client.ws = { readyState: 1, send: () => {}, close: () => {} }
  client.initialized = true
  client.bridgeIdentity = { bridgeSessionId: 'b', bridgeGeneration: 1 }
  const pending = client.call('zcode-agent', 'helloConversationV4', [], 60000)
  const started = Date.now()
  const raced = Promise.race([
    pending.then(() => 'resolved').catch(e => `rejected: ${e.message}`),
    new Promise(r => setTimeout(() => r('still-pending'), 3000)),
  ])
  await new Promise(r => setTimeout(r, 0)) // let call() register its handler
  client.onRelayClose(1006, 'test')
  const outcome = await raced
  const elapsed = Date.now() - started
  assert('close rejects the in-flight call', outcome.startsWith('rejected: relay closed (1006)'))
  assert('the rejection is immediate, not the rpc timeout', elapsed < 1000)
  assert('close resets the handshake state', client.initialized === false)
  assert('no channel handler survives close', client.channelHandlers.size === 0)
  // a waiter for the handshake is rejected too
  const initRace = Promise.race([
    client.waitInitialized(60000).then(() => 'init-resolved').catch(e => `init-rejected: ${e.message}`),
    new Promise(r => setTimeout(() => r('init-pending'), 3000)),
  ])
  client.onRelayClose(1006, 'test')
  assert('close rejects a pending handshake waiter', (await initRace).startsWith('init-rejected: relay closed (1006)'))
}
