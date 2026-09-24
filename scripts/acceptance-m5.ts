/**
 * M5 验收（API 级）：完全通过 HTTP 建群 → 建角色 → 回读 → 修改 → 让新角色真实开口。
 * 群目录 groups/_acc-m5 由脚本创建，finally 删除。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'

const accGroup = '_acc-m5'
const accDir = join(config.groupsDir, accGroup)
const PORT = 8792
const base = `http://127.0.0.1:${PORT}`
const cleanup = (): void => rmSync(accDir, { recursive: true, force: true })

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

interface Ev { type: string; picked?: string; name?: string; text?: string }

async function collect(res: Response): Promise<Ev[]> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  const events: Ev[] = []
  let buf = ''
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
  }
  return events
}

const postJson = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const putJson = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

try {
  cleanup()
  await waitListening()

  // ① 建群
  const created = await postJson('/api/groups', { name: accGroup, era: '（测试时代）', world: '（测试世界观）', tone: '' })
  assert.equal(created.status, 200, `建群失败: ${await created.text()}`)
  assert.ok(((await (await fetch(`${base}/api/groups`)).json()) as { groups: string[] }).groups.includes(accGroup))
  assert.equal((await postJson('/api/groups', { name: accGroup, era: '', world: '', tone: '' })).status, 400, '重名必须拒绝')

  // ①b 零角色的群必须能打开（前端点进新建的群不能白屏）
  const emptySnap = await fetch(`${base}/api/group/${accGroup}`)
  assert.equal(emptySnap.status, 200, `空群快照必须 200，实得 ${emptySnap.status}`)
  assert.deepEqual(((await emptySnap.json()) as { characters: unknown[] }).characters, [])
  console.log('① 建群 ✓（空群可打开）')

  // ② 建角色（模拟前端表单提交）
  const draft = {
    name: '角色甲',
    appearance: '（测试外观）', background: '（测试背景）',
    personality: '（测试性格）', relationships: '（测试关系）',
  }
  const rc = await postJson(`/api/group/${accGroup}/character`, draft)
  assert.equal(rc.status, 200, `建角色失败: ${await rc.text()}`)
  console.log('② 建角色 ✓')

  // ③ 回读草稿
  const back = await (await fetch(`${base}/api/group/${accGroup}/character/角色甲`)).json() as { appearance: string; personality: string; background: string }
  assert.equal(back.personality, '（测试性格）')
  assert.equal(back.background, '（测试背景）')
  assert.equal(back.appearance, '（测试外观）')
  console.log('③ 回读草稿 ✓')

  // ④ 修改资料
  const ru = await putJson(`/api/group/${accGroup}/character/角色甲`, { ...draft, personality: '（改后的性格）' })
  assert.equal(ru.status, 200)
  const back2 = await (await fetch(`${base}/api/group/${accGroup}/character/角色甲`)).json() as { personality: string }
  assert.equal(back2.personality, '（改后的性格）')
  console.log('④ 修改资料 ✓')

  // ④b 用户设定（单文件自由格式）
  const mePut = await putJson(`/api/group/${accGroup}/user`, { name: '（测试称呼）', text: '（测试用户自述）' })
  assert.equal(mePut.status, 200, '用户设定保存失败')
  const meBack = await (await fetch(`${base}/api/group/${accGroup}/user`)).json() as { name: string; text: string }
  assert.deepEqual(meBack, { name: '（测试称呼）', text: '（测试用户自述）' })
  console.log('④b 用户设定 ✓')

  // ⑤ 新角色必须真的能开口（快照 + 流式回复）
  const snap = await (await fetch(`${base}/api/group/${accGroup}`)).json() as { characters: Array<{ name: string }>; userName: string }
  assert.deepEqual(snap.characters.map(c => c.name), ['角色甲'])
  assert.equal(snap.userName, '（测试称呼）', '快照必须带上用户称呼')
  const events = await collect(await postJson(`/api/group/${accGroup}/message`, { text: '角色甲，用一句话介绍一下自己' }))
  assert.equal(events.find(e => e.type === 'route')?.picked, '角色甲', '点名必须由新建角色接话')
  const reply = events.filter(e => e.type === 'delta').map(e => e.text ?? '').join('')
  assert.ok(reply.trim().length > 0, '新建角色必须产出非空回复')
  console.log(`⑤ 新建角色开口 ✓ 回复: ${reply.slice(0, 80)}`)
  console.log('M5 验收通过：HTTP 建群/建角色/回读/修改/真实对话 全链路 ✓')
} finally {
  server.kill()
  cleanup()
}
