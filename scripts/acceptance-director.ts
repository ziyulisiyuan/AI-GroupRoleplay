/**
 * 纠正窗口验收（SPEC §6 M10）：
 * ① 用户直接对总管说话（戏外）→ 总管落实修正（这里：改正在场名单）。
 * ② 修正生效：被改成"不在场"的角色不再获知新事；在场的照常知道。
 * ③ 偷听情形（名单管不到的场景）：用户告诉总管"某人其实一直躲着偷听" →
 *    总管用知情记录显式补给他——证明原则而非例子在起作用。
 * ④ 反向修正：让总管撤回那条记忆 → 他的账本里不再有。
 * ⑤ 戏外对话永不下发给角色：角色的记忆里不得出现纠正对话的内容。
 * 群目录 groups/_acc-director 由夹具现造，结束（含失败路径）必删。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'

const accGroup = '_acc-director'
const accDir = join(config.groupsDir, accGroup)
const PORT = 8797
const base = `http://127.0.0.1:${PORT}`
const cleanup = (): void => rmSync(accDir, { recursive: true, force: true })

const [A, B] = TEST_CAST
const SECRET = '口令是银色'
const EAVESDROP_MARK = '一直躲在柜子里偷听'   // 只出现在戏外对话里的措辞，用于验证"戏外不泄漏"

const server = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'server.ts')], {
  cwd: config.root, env: { ...process.env, HOST_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
})

const postJson = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function say(text: string): Promise<string> {
  const res = await postJson(`/api/group/${accGroup}/message`, { text })
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line === '') continue
      const ev = JSON.parse(line) as { type: string; text?: string }
      if (ev.type === 'delta') out += ev.text ?? ''
    }
  }
  return out
}
const talkToDirector = async (text: string): Promise<{ reply: string; applied: string[] }> => {
  const r = await postJson(`/api/group/${accGroup}/director`, { text })
  const body = await r.json() as { reply?: string; applied?: string[]; error?: string }
  assert.equal(r.status, 200, `总管未回应: ${body.error ?? JSON.stringify(body)}`)
  return { reply: body.reply ?? '', applied: body.applied ?? [] }
}
const memoryText = (name: string): string => {
  const p = join(accDir, '角色', name, '记忆.jsonl')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}
const snapshot = async (): Promise<{ present: string[]; absent: string[] }> =>
  await (await fetch(`${base}/api/group/${accGroup}`)).json() as { present: string[]; absent: string[] }

async function waitListening(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/groups`)).ok) return } catch { /* 未就绪 */ }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error('server 未就绪')
}

try {
  cleanup()
  buildGroupFixture(accDir, { chars: TEST_CAST.slice(0, 2) })
  await waitListening()

  // ① 直接跟总管说话：改正在场名单（只有甲在场）
  console.log('① 对总管说：把在场改成只有甲……')
  const r1 = await talkToDirector(`你弄错了：现在屋里只有${A.name}一个人，${B.name}在另一栋房子，绝对听不到。请把在场名单改成只有${A.name}。`)
  assert.ok(r1.reply.trim() !== '', '总管必须给出文字回应')
  const snap1 = await snapshot()
  assert.ok(snap1.present.includes(A.name) && !snap1.present.includes(B.name), `在场名单应被改成只有甲，实得 ${JSON.stringify(snap1.present)}`)
  console.log(`① 修正生效 ✓（在场：${snap1.present.join('、')}；已改：${r1.applied.join('；') || '（无）'}）`)

  // ② 修正之后：不在场者不再获知新事
  await say(`（我当众低声说）${SECRET}。`)
  assert.ok(memoryText(A.name).includes('银色'), '在场者甲应知道')
  assert.ok(!memoryText(B.name).includes('银色'), '已被判定不在场的乙不得知道')
  console.log('② 不在场者不获知 ✓')

  // ③ 偷听情形：名单管不到，但剧情上他确实听到了 → 由总管显式补记
  console.log('③ 对总管说：乙其实在偷听……')
  const r3 = await talkToDirector(`补充设定：${B.name}${EAVESDROP_MARK}，刚才那句他其实听到了（${SECRET}）。请按这个事实补记他该知道的内容。`)
  assert.ok(r3.reply.trim() !== '')
  assert.ok(memoryText(B.name).includes('银色'), `总管应把偷听得知的内容补记给乙。总管回复：${r3.reply}\n乙的记忆：${memoryText(B.name)}`)
  console.log(`③ 偷听情形由总管显式补记 ✓（已改：${r3.applied.join('；') || '（无）'}）`)

  // ④ 反向修正：撤回那条记忆
  const r4 = await talkToDirector(`再改一次：${B.name}其实什么也没听到，请把他关于「银色」的记忆撤回。`)
  assert.ok(!memoryText(B.name).includes('银色'), `撤回后乙不得再知道。总管回复：${r4.reply}\n乙的记忆：${memoryText(B.name)}`)
  console.log('④ 撤回记忆生效 ✓')

  // ⑤ 戏外对话绝不进入角色视野
  assert.ok(!memoryText(A.name).includes(EAVESDROP_MARK), '甲的记忆不得出现戏外对话内容')
  assert.ok(!memoryText(B.name).includes(EAVESDROP_MARK), '乙的记忆不得出现戏外对话内容')
  const log = readFileSync(join(accDir, '剧情.jsonl'), 'utf8')
  assert.ok(log.includes('"type":"director"'), '戏外对话应作为 director 行留档（可回看/可审计）')
  console.log('⑤ 戏外对话留档但不下发 ✓')
  console.log('纠正窗口验收通过：改正名单 / 生效 / 偷听补记 / 撤回 / 戏外隔离 ✓')
} finally {
  server.kill()
  cleanup()
}
