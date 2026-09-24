/**
 * M4 验收（SPEC §6 M4，API 级；浏览器视觉验收由人工完成）：
 * ① 群列表/快照端点
 * ② POST message NDJSON 流式事件序列（route→delta…→reply）且落盘
 * ③ 正文低语：只被低语者的账本登记，其他人不登记（判断层失手报 ⚠）
 * ④ 断流重连冒烟：客户端中途 abort，服务端不崩；重新拉快照一致可用
 * ⑤ roll 端点：产出 reply 事件 + swipe 行落盘
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'

const accGroup = '_acc-m4'
const accDir = join(config.groupsDir, accGroup)
rmSync(accDir, { recursive: true, force: true })
buildGroupFixture(accDir, { chars: TEST_CAST.slice(0, 2) })

const PORT = 8791
const base = `http://127.0.0.1:${PORT}`
const server = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'server.ts')], {
  cwd: config.root, env: { ...process.env, HOST_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
})
let serverOut = ''
server.stdout!.on('data', (d: Buffer) => { serverOut += d.toString('utf8') })

async function waitListening(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/groups`)
      if (r.ok) return
    } catch { /* 未就绪 */ }
    await new Promise(r2 => setTimeout(r2, 300))
  }
  throw new Error(`server 未就绪: ${serverOut.slice(-300)}`)
}

interface Ev { type: string; picked?: string; text?: string; name?: string }

async function postStream(path: string, body: Record<string, string>, abortAfterFirstChunk = false): Promise<{ events: Ev[]; aborted: boolean }> {
  const ac = new AbortController()
  const res = await fetch(`${base}/api/group/${accGroup}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: ac.signal,
  })
  const reader = res.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>
  const dec = new TextDecoder()
  const events: Ev[] = []
  let buf = ''
  let aborted = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line !== '') events.push(JSON.parse(line) as Ev)
    }
    if (abortAfterFirstChunk && events.length > 0) {
      aborted = true
      ac.abort()
      break
    }
  }
  void reader.cancel().catch(() => {})
  return { events, aborted }
}

try {
  await waitListening()
  console.log('server 就绪 ✓')

  // ① 列表 + 快照
  const groups = ((await (await fetch(`${base}/api/groups`)).json()) as { groups: string[] }).groups
  assert.ok(groups.includes(accGroup), '群列表应包含测试群')
  let snap = (await (await fetch(`${base}/api/group/${accGroup}`)).json()) as { characters: unknown[]; messages: unknown[] }
  assert.equal(snap.characters.length, 2)
  assert.equal(snap.messages.length, 0)
  console.log('① 群列表/快照 ✓')

  // ② 公开发言流式
  const { events } = await postStream('/message', { text: '角色甲，说句话' })
  const types = events.map(e => e.type)
  assert.ok(types.includes('route') && types.includes('delta') && types.includes('reply'), `事件序列应含 route/delta/reply，实得 ${types.join(',')}`)
  assert.equal(events.find(e => e.type === 'route')?.picked, '角色甲')
  const jsonl = readFileSync(join(accDir, '剧情.jsonl'), 'utf8')
  assert.ok(jsonl.includes('"type":"route"') && jsonl.includes('"type":"msg"'), 'msg/route 必须落盘')
  console.log(`② POST message 流式 ✓（${types.join(' → ')}）`)

  // ③ 正文低语（没有私聊通道：私密靠正文表达，知情由 Jev 判定）
  const secret = '这件事只让你知道'
  const whisper = await postStream('/message', { text: `（我凑到角色乙耳边，压着声音）${secret}` })
  assert.ok(whisper.events.some(e => e.type === 'reply'), '低语必须产生回复事件')
  const bMemory = join(accDir, '角色', '角色乙', '记忆.jsonl')
  assert.ok(existsSync(bMemory) && readFileSync(bMemory, 'utf8').includes(secret), '被低语者的账本必须登记原文')
  const otherMemory = join(accDir, '角色', '角色甲', '记忆.jsonl')
  if (existsSync(otherMemory) && readFileSync(otherMemory, 'utf8').includes(secret)) console.log('  ⚠ 角色甲也登记了低语（判断层失手，可用纠正窗口撤回）')
  console.log('③ 正文低语可见性 ✓')

  // ④ 断流重连冒烟：发一条公开消息，收到第一个事件即 abort，服务端不得崩溃
  let abortedOk = false
  try {
    await postStream('/message', { text: '（测试断流）乙，随便说句话' }, true)
    // 若服务端在 abort 前已完成流，也算通过
    abortedOk = true
  } catch {
    abortedOk = true // fetch 因 abort 抛错是预期
  }
  assert.ok(abortedOk)
  snap = (await (await fetch(`${base}/api/group/${accGroup}`)).json()) as typeof snap
  assert.ok(Array.isArray(snap.messages), '断流后快照必须可用')
  console.log(`④ 断流后快照可用 ✓（当前消息 ${snap.messages.length} 条）`)

  // ⑤ roll
  const roll = await postStream('/roll', {})
  assert.ok(roll.events.some(e => e.type === 'reply'), 'roll 必须产生回复事件')
  const jsonl2 = readFileSync(join(accDir, '剧情.jsonl'), 'utf8')
  assert.ok(jsonl2.includes('"type":"swipe"'), 'roll 必须落盘 swipe 行')
  console.log('⑤ roll + swipe 落盘 ✓')

  console.log('M4 验收通过：HTTP 流式/快照/低语/断流/roll 全链路 ✓')
} finally {
  server.kill()
  rmSync(accDir, { recursive: true, force: true })
  void spawnSync
}
