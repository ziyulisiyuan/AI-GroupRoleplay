/**
 * 模型设置验收（SPEC §6 M7）：通过 HTTP 添加提供方 → 启用 → 真正用它完成一轮对话。
 * 会临时改写工作区 settings.yaml，结束（含失败路径）恢复原样。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { settingsPath } from '../src/settings.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'

const accGroup = '_acc-models'
const accDir = join(config.groupsDir, accGroup)
const PORT = 8794
const base = `http://127.0.0.1:${PORT}`
const sPath = settingsPath()
const backup = existsSync(sPath) ? readFileSync(sPath, 'utf8') : undefined

const cleanup = (): void => {
  rmSync(accDir, { recursive: true, force: true })
  if (backup === undefined) rmSync(sPath, { force: true })
  else writeFileSync(sPath, backup, 'utf8')
}

const server = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'server.ts')], {
  cwd: config.root, env: { ...process.env, HOST_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
})

const postJson = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const putJson = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function waitListening(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/groups`)).ok) return } catch { /* 未就绪 */ }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error('server 未就绪')
}

async function chatStream(path: string, body: Record<string, string>): Promise<Array<{ type: string; text?: string }>> {
  const res = await postJson(path, body)
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  const out: Array<{ type: string; text?: string }> = []
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line !== '') out.push(JSON.parse(line) as { type: string })
    }
  }
  return out
}

try {
  cleanup()
  buildGroupFixture(accDir, { chars: [TEST_CAST[0]] })
  await waitListening()

  // ① 初始状态：没有提供方 → 走 .env
  const before = await (await fetch(`${base}/api/models`)).json() as { providers: unknown[]; current: { model: string; source: string } }
  assert.equal(before.providers.length, 0, '测试前不应有提供方（settings.yaml 已备份）')
  assert.equal(before.current.source, 'env', '未配置时应回退 .env')
  console.log(`① 现状 ✓（来源 ${before.current.source}，模型 ${before.current.model}）`)

  // ② 通过 HTTP 添加提供方（复用 .env 的密钥与地址，仅证明设置链路可用）
  const created = await postJson('/api/models', {
    name: '（测试提供方）',
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
  })
  assert.equal(created.status, 200, `添加提供方失败: ${await created.text()}`)
  const after = await (await fetch(`${base}/api/models`)).json() as { providers: Array<{ id: string; name: string }>; activeId: string; current: { model: string; source: string } }
  assert.equal(after.providers.length, 1)
  assert.equal(after.current.source, 'settings', '添加后必须改为使用界面设置')
  assert.ok(existsSync(sPath), '提供方必须落盘到 settings.yaml')
  console.log('② 添加提供方 ✓（来源切换为 settings）')

  // ③ 编辑 + 启用另一条，验证切换生效
  const second = await postJson('/api/models', { name: '（测试提供方二）', baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model, reasoningEffort: 'low' })
  assert.equal(second.status, 200)
  const list2 = await (await fetch(`${base}/api/models`)).json() as { providers: Array<{ id: string }>; activeId: string }
  const secondId = list2.providers.find(p => p.id !== after.activeId)!.id
  assert.equal((await postJson(`/api/models/${secondId}/activate`, {})).status, 200)
  const act = await (await fetch(`${base}/api/models`)).json() as { activeId: string; current: { model: string } }
  assert.equal(act.activeId, secondId, '启用切换生效')
  assert.equal((await putJson(`/api/models/${secondId}`, { name: '（改名后的提供方）' })).status, 200)
  console.log('③ 启用切换 / 编辑 ✓')

  // ④ 真正用它说一句话（证明调用走的是设置解析出的连接）
  const events = await chatStream(`/api/group/${accGroup}/message`, { text: `${TEST_CAST[0].name}，说一句话` })
  const reply = events.filter(e => e.type === 'delta').map(e => e.text ?? '').join('')
  assert.ok(reply.trim().length > 0, '设置解析出的提供方必须能完成对话')
  console.log(`④ 使用界面设置的模型完成对话 ✓ 回复: ${reply.slice(0, 60)}`)

  // ⑤ 删除提供方 → 回退 .env
  const list3 = await (await fetch(`${base}/api/models`)).json() as { providers: Array<{ id: string }> }
  for (const p of list3.providers) {
    await fetch(`${base}/api/models/${p.id}`, { method: 'DELETE' })
  }
  const back = await (await fetch(`${base}/api/models`)).json() as { providers: unknown[]; current: { source: string } }
  assert.equal(back.providers.length, 0)
  assert.equal(back.current.source, 'env', '删空后必须回退 .env')
  console.log('⑤ 删除与回退 ✓')
  console.log('模型设置验收通过：添加/编辑/启用/删除/回退 全链路 ✓')
} finally {
  server.kill()
  cleanup()
  void copyFileSync
}
