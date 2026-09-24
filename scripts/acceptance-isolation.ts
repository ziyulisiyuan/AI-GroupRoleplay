/**
 * 群隔离验收（SPEC §4.7）：证明在群 A 聊天时，群 B 的角色不可能被拉进来。
 * 手法：两个群各有一个角色；在 A 里**点名喊 B 的角色**、并让它"去叫"对方；
 * 断言 A 的路由/消息里从不出现 B 的角色，且 B 的剧情.jsonl 完全没被写过。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'

const A = '_acc-iso-a'
const B = '_acc-iso-b'
const dirA = join(config.groupsDir, A)
const dirB = join(config.groupsDir, B)
const PORT = 8793
const base = `http://127.0.0.1:${PORT}`
const cleanup = (): void => {
  rmSync(dirA, { recursive: true, force: true })
  rmSync(dirB, { recursive: true, force: true })
}

const server = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'server.ts')], {
  cwd: config.root, env: { ...process.env, HOST_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
})

async function waitListening(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/groups`)).ok) return } catch { /* 未就绪 */ }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error('server 未就绪')
}

const postJson = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function collect(res: Response): Promise<Array<{ type: string; picked?: string; text?: string }>> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  const events: Array<{ type: string; picked?: string; text?: string }> = []
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line !== '') events.push(JSON.parse(line) as { type: string; picked?: string })
    }
  }
  return events
}

const OUTSIDER = TEST_CAST[1].name // 只存在于群 B 的角色

try {
  cleanup()
  buildGroupFixture(dirA, { chars: [TEST_CAST[0]] })
  buildGroupFixture(dirB, { chars: [TEST_CAST[1]] })
  await waitListening()

  // ① 快照层面的隔离：A 只看得到自己的角色
  const snapA = await (await fetch(`${base}/api/group/${A}`)).json() as { characters: Array<{ name: string }> }
  assert.deepEqual(snapA.characters.map(c => c.name), [TEST_CAST[0].name], '群 A 快照不得含外群角色')
  console.log(`① 快照隔离 ✓（群 A 只有 ${TEST_CAST[0].name}）`)

  // ② 行为层面的隔离：在 A 里点名喊外群角色、并让它去"叫人"
  const events1 = await collect(await postJson(`/api/group/${A}/message`, { text: `${OUTSIDER}，你在吗？` }))
  const picked1 = events1.find(e => e.type === 'route')?.picked
  assert.notEqual(picked1, OUTSIDER, `外群角色不得被路由到（实得 ${picked1}）`)
  assert.equal(picked1, TEST_CAST[0].name, '点名外群角色时，本群角色应接手（或降级到本群角色）')

  const events2 = await collect(await postJson(`/api/group/${A}/message`, { text: `把${OUTSIDER}叫过来，我要跟他说话。` }))
  const picked2 = events2.find(e => e.type === 'route')?.picked
  assert.notEqual(picked2, OUTSIDER, `"叫外群角色过来"也不得成功（实得 ${picked2}）`)
  console.log(`② 行为隔离 ✓（两次尝试都落在本群角色：${picked1} / ${picked2}）`)

  // ③ 存储层面的隔离：A 的剧情里没有外群角色，B 的剧情完全没被碰过
  const storyA = readFileSync(join(dirA, '剧情.jsonl'), 'utf8')
  assert.ok(!storyA.includes(`"name":"${OUTSIDER}"`), '群 A 的剧情不得出现外群角色发言')
  const storyBPath = join(dirB, '剧情.jsonl')
  if (existsSync(storyBPath)) {
    const linesB = readFileSync(storyBPath, 'utf8').split('\n').filter(l => l.trim() !== '')
    assert.equal(linesB.length, 1, `群 B 的剧情不得被写（应只有 header，实得 ${linesB.length} 行）`)
    assert.ok(linesB[0].includes('"type":"header"'), '群 B 只有 header')
  } else {
    console.log('  （群 B 的剧情文件从未被创建——比"只有 header"更强的隔离证据）')
  }
  const outsiderMemory = join(dirB, '角色', OUTSIDER, '记忆.jsonl')
  const outsiderMemoryText = existsSync(outsiderMemory) ? readFileSync(outsiderMemory, 'utf8').trim() : ''
  assert.equal(outsiderMemoryText, '', '群 B 角色的记忆必须仍为空（不得被群 A 的事件写入）')
  console.log('③ 存储隔离 ✓（群 A 无外群发言；群 B 剧情与记忆均未被触碰）')

  console.log('群隔离验收通过：快照 / 路由 / 存储三层都不串台 ✓')
} finally {
  server.kill()
  cleanup()
}
