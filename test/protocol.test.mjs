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

// out-of-order drop safety
const asm3 = new RpcAssembler()
const r3 = asm3.accept({ ...frames2[frames2.length - 1] })
assert('tail frame without head is dropped', r3.kind === 'dropped')
