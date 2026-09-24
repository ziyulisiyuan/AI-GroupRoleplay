/**
 * 手动改上下文验收（SPEC §6 M8）：
 * ① 改一条剧情消息（用户原话）→ 角色下一轮按**新文本**理解（旧说法不再出现）。
 * ② 删一条消息 → 从快照/角色可见视图中消失。
 * ③ 给某角色手动补一条记忆 → 只有他读到（另一角色读不到）。
 * ④ 撤回该记忆 → 他不再读到，且 rebuild 后也不会复现。
 * 群目录 groups/_acc-ctx 由夹具现造，结束（含失败路径）必删。
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'

const accGroup = '_acc-ctx'
const accDir = join(config.groupsDir, accGroup)
const PORT = 8795
const base = `http://127.0.0.1:${PORT}`
const cleanup = (): void => rmSync(accDir, { recursive: true, force: true })

const A = TEST_CAST[0]            // 主要测试对象
const B = TEST_CAST[1]            // 用来验证"记忆只给指定角色"
const OLD_WORD = '红色'
const NEW_WORD = '蓝色'

const server = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'server.ts')], {
  cwd: config.root, env: { ...process.env, HOST_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
})

const postJson = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

interface Ev { type: string; picked?: string; text?: string }
async function events(res: Response): Promise<Ev[]> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  const out: Ev[] = []
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line !== '') out.push(JSON.parse(line) as Ev)
    }
  }
  return out
}
const say = async (who: string, text: string): Promise<string> => {
  const evs = await events(await postJson(`/api/group/${accGroup}/message`, { text }))
  void who
  return evs.filter(e => e.type === 'delta').map(e => e.text ?? '').join('')
}

interface Snapshot { characters: Array<{ name: string; dirName: string }>; messages: Array<{ id: number; text: string; name: string }> }
const snapshot = async (): Promise<Snapshot> => await (await fetch(`${base}/api/group/${accGroup}`)).json() as Snapshot

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

  // 准备：告诉角色甲一个事实
  await say(A.name, `${A.name}，记住：口令是${OLD_WORD}。`)
  let snap = await snapshot()
  const target = snap.messages.find(m => m.text.includes(`口令是${OLD_WORD}`))
  assert.ok(target !== undefined, '应能找到那条消息')

  // ① 手改：把 红色 改成 蓝色
  const edited = await postJson(`/api/group/${accGroup}/message/${target.id}/edit`, { text: `${A.name}，记住：口令是${NEW_WORD}。` })
  assert.equal(edited.status, 200, `编辑失败: ${await edited.text()}`)
  snap = await snapshot()
  assert.ok(snap.messages.find(m => m.id === target.id)?.text.includes(NEW_WORD), '快照必须反映新文本')
  assert.ok(!snap.messages.find(m => m.id === target.id)?.text.includes(OLD_WORD), '快照不得再有旧文本')

  const answer = await say(A.name, `${A.name}，口令是什么颜色？只回答颜色。`)
  assert.ok(answer.includes(NEW_WORD), `角色必须按改后的文本理解（实得: ${answer}）`)
  assert.ok(!answer.includes(OLD_WORD), `角色不得再说旧口径（实得: ${answer}）`)
  console.log(`① 改消息 → 角色读到新内容 ✓（回复: ${answer.slice(0, 40)}）`)

  // ② 手删：那条消息从可见视图消失
  const del = await postJson(`/api/group/${accGroup}/message/${target.id}/delete`, {})
  assert.equal(del.status, 200)
  snap = await snapshot()
  assert.ok(!snap.messages.some(m => m.id === target.id), '被删消息不得出现在快照中')
  console.log('② 删消息 → 从可见视图消失 ✓')

  // ③ 手动补记忆：只给角色甲
  const addMem = await postJson(`/api/group/${accGroup}/character/${A.name}/memory`, { text: `（测试记忆：${A.name}知道一个暗号）` })
  assert.equal(addMem.status, 200)
  const memA = await (await fetch(`${base}/api/group/${accGroup}/character/${A.name}/memory`)).json() as { entries: Array<{ index: number; text: string; source: string }> }
  const added = memA.entries.find(e => e.text.includes('暗号'))
  assert.ok(added !== undefined, '角色甲的记忆里应有刚补的条目')
  assert.equal(added.source, '用户指定', '来源应标为用户指定')
  const memB = await (await fetch(`${base}/api/group/${accGroup}/character/${B.name}/memory`)).json() as { entries: Array<{ text: string }> }
  assert.ok(!memB.entries.some(e => e.text.includes('暗号')), '另一角色的记忆不得受影响')
  console.log('③ 补记忆 → 只有指定角色读到 ✓')

  // ④ 撤回该记忆 + rebuild 后不复现
  const rm = await fetch(`${base}/api/group/${accGroup}/character/${A.name}/memory/${added.index}`, { method: 'DELETE' })
  assert.equal(rm.status, 200)
  const memA2 = await (await fetch(`${base}/api/group/${accGroup}/character/${A.name}/memory`)).json() as { entries: Array<{ text: string }> }
  assert.ok(!memA2.entries.some(e => e.text.includes('暗号')), '撤回后不得再读到')

  server.kill()
  const rb = spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('scripts', 'rebuild.ts'), accGroup], {
    cwd: config.root, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(rb.status, 0, `rebuild 失败: ${rb.stderr?.slice(-200)}`)
  const { loadFiles } = await import('../src/group/status.ts')
  const after = loadFiles(join(accDir, '角色', A.name))
  assert.ok(!after.memory.some(e => e.text.includes('暗号')), 'rebuild 后撤回的记忆不得复现')
  console.log('④ 撤回记忆 → rebuild 后仍不复现 ✓')
  console.log('手动改上下文验收通过：消息改/删即时生效，记忆增删只影响指定角色，且与 rebuild 一致 ✓')
} finally {
  server.kill()
  cleanup()
}
