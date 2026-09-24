/**
 * HTTP Host（SPEC §4.6）：hono + @hono/node-server。
 * 对话：GET  /api/groups · GET /api/group/{name}（快照） · GET /api/group/{name}/status
 *       POST /api/group/{name}/message|roll → NDJSON SessionEvent 流
 * 编辑器：POST /api/groups · PUT /api/group/{name}/settings · GET|PUT /api/group/{name}/user
 *       POST /api/group/{name}/character · GET|PUT /api/group/{name}/character/{dir}
 * 全局：GET|PUT /api/rules（用户自写约束词）· GET|POST /api/models · PUT|DELETE /api/models/{id} · POST /api/models/{id}/activate
 */
import { Hono, type Context } from 'hono'
import { serve } from '@hono/node-server'
import { stream } from 'hono/streaming'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.ts'
import { GroupSession, listGroups, type SessionEvent } from './group/engine.ts'
import {
  createCharacter, createGroup, isValidName, readCharacterDraft, saveGroupSettings, saveUserPersona, updateCharacter,
  type CharacterDraft,
} from './group/scaffold.ts'
import { loadUserPersona } from './group/persona.ts'
import { parseRemoteList } from './group/presence.ts'
import { loadRules, saveRules } from './group/rules.ts'
import { loadSettings, saveSettings, resolveLlm, healOrphanSettingsBackup, type Provider } from './settings.ts'
import { registerStatic } from './server-static.ts'

const PORT = Number(process.env.HOST_PORT ?? 8787)
/** 绑定地址：不设 = 默认（全部网卡，PC 现状不变）；安卓壳设 127.0.0.1 只绑回环。 */
const HOST_BIND = process.env.HOST_BIND || undefined
const sessions = new Map<string, GroupSession>()

// 启动自愈：上次离线自检若被硬崩溃打断，mock 配置会留在 settings.yaml 上——有孤儿备份就先还原
healOrphanSettingsBackup()

function getSession(name: string): GroupSession {
  let s = sessions.get(name)
  if (s === undefined) {
    s = GroupSession.open(name)
    sessions.set(name, s)
  }
  return s
}

const app = new Hono()
app.onError((err, c) => c.json({ error: err.message }, 400))

app.get('/api/groups', c => c.json({ groups: listGroups() }))
app.get('/api/group/:name', c => c.json(getSession(c.req.param('name')).snapshot()))
app.get('/api/group/:name/status', c => c.json({ lines: getSession(c.req.param('name')).statusLines() }))

/** 判定/后台运行日志（判定.jsonl 尾部，倒序返回；只给人看，供侧边栏"运行日志"面板）。 */
app.get('/api/group/:name/judgments', c => {
  const dir = groupDir(c.req.param('name'))
  const file = join(dir, '判定.jsonl')
  if (!existsSync(file)) return c.json({ lines: [] })
  const raw = readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .slice(-200)
    .flatMap(l => {
      try { return [JSON.parse(l) as Record<string, unknown>] } catch { return [] } // 坏行忽略
    })
    .reverse()
  return c.json({ lines: raw })
})

async function runEvents(c: Context, gen: AsyncGenerator<SessionEvent>): Promise<Response> {
  return stream(c, async s => {
    // 断线后不再发送、但把生成器完整跑完——记账（msg 行/ledger/回填）由代码保证，不依赖框架吞错
    let broken = false
    for await (const ev of gen) {
      if (broken) continue
      try {
        await s.write(`${JSON.stringify(ev)}\n`)
      } catch {
        broken = true // 客户端断开（断流重连 = 重新拉快照）
      }
    }
  })
}

app.post('/api/group/:name/message', async c => {
  const body = await c.req.json<Record<string, string>>().catch(() => ({}) as Record<string, string>)
  const text = (body.text ?? '').trim()
  if (text === '') return c.json({ error: 'text 不能为空' }, 400)
  return runEvents(c, getSession(c.req.param('name')).speak(text))
})

app.post('/api/group/:name/roll', c => runEvents(c, getSession(c.req.param('name')).roll()))

// ---------- 编辑器（M5）：建群 / 群设定 / 角色资料 ----------

function groupDir(name: string): string {
  if (!isValidName(name)) throw new Error('非法群聊名')
  return join(config.groupsDir, name)
}

app.post('/api/groups', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const name = String(body.name ?? '').trim()
  const dir = groupDir(name)
  if (existsSync(dir)) return c.json({ error: `群聊「${name}」已存在` }, 400)
  createGroup(dir, {
    era: String(body.era ?? ''),
    world: String(body.world ?? ''),
    tone: String(body.tone ?? ''),
  })
  return c.json({ ok: true, name })
})

app.put('/api/group/:name/settings', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const dir = groupDir(c.req.param('name'))
  if (!existsSync(dir)) return c.json({ error: '群聊不存在' }, 400)
  saveGroupSettings(dir, { era: String(body.era ?? ''), world: String(body.world ?? ''), tone: String(body.tone ?? '') })
  sessions.delete(c.req.param('name')) // 设定变了，丢弃缓存的会话
  return c.json({ ok: true })
})

// 用户设定（自由格式单文件）：角色与总管都会读到
app.get('/api/group/:name/user', c => {
  const dir = groupDir(c.req.param('name'))
  if (!existsSync(dir)) return c.json({ error: '群聊不存在' }, 400)
  return c.json(loadUserPersona(dir))
})

app.put('/api/group/:name/user', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const dir = groupDir(c.req.param('name'))
  if (!existsSync(dir)) return c.json({ error: '群聊不存在' }, 400)
  const name = String(body.name ?? '').trim()
  if (name.length > 60) return c.json({ error: '称呼过长' }, 400)
  saveUserPersona(dir, { name: name === '' ? '你' : name, text: String(body.text ?? '') })
  sessions.delete(c.req.param('name'))
  return c.json({ ok: true })
})

function draftFrom(body: Record<string, unknown>): CharacterDraft {
  return {
    name: String(body.name ?? '').trim(),
    appearance: String(body.appearance ?? ''),
    background: String(body.background ?? ''),
    personality: String(body.personality ?? ''),
    relationships: String(body.relationships ?? ''),
  }
}

/** 角色目录参数校验（防路径穿越——与群名/角色名同一套规则）。 */
function validDirName(dir: string): string {
  if (!isValidName(dir)) throw new Error('非法角色目录名')
  return dir
}

app.post('/api/group/:name/character', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const dir = groupDir(c.req.param('name'))
  if (!existsSync(dir)) return c.json({ error: '群聊不存在' }, 400)
  const draft = draftFrom(body)
  if (!isValidName(draft.name)) return c.json({ error: '非法角色名' }, 400)
  createCharacter(dir, draft)
  sessions.delete(c.req.param('name'))
  return c.json({ ok: true, name: draft.name, dirName: draft.name })
})

app.get('/api/group/:name/character/:dir', c => {
  const dir = groupDir(c.req.param('name'))
  return c.json(readCharacterDraft(dir, validDirName(c.req.param('dir'))))
})

app.put('/api/group/:name/character/:dir', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const dir = groupDir(c.req.param('name'))
  updateCharacter(dir, validDirName(c.req.param('dir')), draftFrom(body))
  sessions.delete(c.req.param('name'))
  return c.json({ ok: true })
})

// ---------- 纠正窗口：用户直接跟总管说话（戏外，§3.12） ----------

app.get('/api/group/:name/director', c => {
  const session = getSession(c.req.param('name'))
  return c.json({ history: session.directorHistory() })
})

app.post('/api/group/:name/director', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const text = String(body.text ?? '').trim()
  if (text === '') return c.json({ error: '内容不能为空' }, 400)
  const result = await getSession(c.req.param('name')).correct(text)
  return c.json(result)
})

// ---------- 在场者（§3.11） ----------

app.get('/api/group/:name/presence', c => {
  const s = getSession(c.req.param('name')).snapshot()
  return c.json({ present: s.present, remote: s.remote, overhear: s.overhear, absent: s.absent, characters: s.characters.map(x => x.name) })
})

app.put('/api/group/:name/presence', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const present = Array.isArray(body.present) ? (body.present as unknown[]).map(String) : []
  const s = getSession(c.req.param('name'))
  // remote/overhear 不传 = 保持现状（用户只勾选现场者时不应顺手断开正在进行的接入/偷听）
  const cur = s.sceneAccess()
  const remote = parseRemoteList(body.remote) ?? cur.remote
  const overhear = parseRemoteList(body.overhear) ?? cur.overhear
  s.setScene({ present, remote, overhear }, '用户手动修正')
  // 手动修正带人进场，同样触发"现场所见"（§5.8）：进门就该看见
  s.maybeSnapshotEntrants(cur.present, '手动修正进场')
  return c.json({ ok: true })
})

// ---------- 手动改上下文（SPEC §3.10） ----------

app.post('/api/group/:name/message/:id/edit', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: '非法消息号' }, 400)
  getSession(c.req.param('name')).editMessage(id, String(body.text ?? ''))
  return c.json({ ok: true })
})

app.post('/api/group/:name/message/:id/delete', c => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id)) return c.json({ error: '非法消息号' }, 400)
  getSession(c.req.param('name')).deleteMessage(id)
  return c.json({ ok: true })
})

app.get('/api/group/:name/character/:dir/memory', c => {
  const session = getSession(c.req.param('name'))
  const dirName = validDirName(c.req.param('dir'))
  const target = session.snapshot().characters.find(x => x.dirName === dirName)
  if (target === undefined) return c.json({ error: '角色不存在' }, 404)
  return c.json({ entries: session.memoryOf(target.name) })
})

app.post('/api/group/:name/character/:dir/memory', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const session = getSession(c.req.param('name'))
  const target = session.snapshot().characters.find(x => x.dirName === validDirName(c.req.param('dir')))
  if (target === undefined) return c.json({ error: '角色不存在' }, 404)
  session.addMemory(target.name, String(body.text ?? ''))
  return c.json({ ok: true })
})

app.delete('/api/group/:name/character/:dir/memory/:index', c => {
  const session = getSession(c.req.param('name'))
  const target = session.snapshot().characters.find(x => x.dirName === validDirName(c.req.param('dir')))
  if (target === undefined) return c.json({ error: '角色不存在' }, 404)
  const index = Number(c.req.param('index'))
  if (!Number.isInteger(index)) return c.json({ error: '非法条目号' }, 400)
  session.retractMemory(target.name, index)
  return c.json({ ok: true })
})

// ---------- 头像（§7.2）：纯显示，永不进任何模型/总管输入 ----------

const AVATAR_MAX_BYTES = 2 * 1024 * 1024

/** 魔数嗅探图片类型；非 jpeg/png/webp/gif 返回 undefined。 */
function sniffImage(b: Uint8Array): string | undefined {
  if (b.length < 12) return undefined
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif'
  return undefined
}

function serveAvatar(c: Context, dir: string, filename: string): Response {
  const p = join(dir, filename)
  if (!existsSync(p)) return c.json({ error: '未设置头像' }, 404)
  const buf = readFileSync(p)
  if (sniffImage(buf) === undefined) return c.json({ error: '未设置头像' }, 404)
  return c.body(buf, 200, { 'content-type': sniffImage(buf)!, 'cache-control': 'no-cache' })
}

async function storeAvatar(c: Context, dir: string, filename: string): Promise<Response> {
  const buf = Buffer.from(await c.req.arrayBuffer())
  if (buf.length === 0) return c.json({ error: '请求体为空' }, 400)
  if (buf.length > AVATAR_MAX_BYTES) return c.json({ error: '头像不能超过 2MB' }, 400)
  if (sniffImage(buf) === undefined) return c.json({ error: '仅支持 jpeg/png/webp/gif 图片' }, 400)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, filename), buf)
  return c.json({ ok: true })
}

app.get('/api/group/:name/avatar', c => serveAvatar(c, groupDir(c.req.param('name')), '头像.dat'))
app.put('/api/group/:name/avatar', async c => storeAvatar(c, groupDir(c.req.param('name')), '头像.dat'))
app.get('/api/group/:name/user/avatar', c => serveAvatar(c, groupDir(c.req.param('name')), '用户头像.dat'))
app.put('/api/group/:name/user/avatar', async c => storeAvatar(c, groupDir(c.req.param('name')), '用户头像.dat'))
const charAvatarDirOf = (name: string | undefined, dir: string | undefined): string =>
  join(groupDir(name ?? ''), '角色', validDirName(dir ?? ''))
app.get('/api/group/:name/character/:dir/avatar', c => serveAvatar(c, charAvatarDirOf(c.req.param('name'), c.req.param('dir')), '头像.dat'))
app.put('/api/group/:name/character/:dir/avatar', async c => storeAvatar(c, charAvatarDirOf(c.req.param('name'), c.req.param('dir')), '头像.dat'))

// ---------- 状态账本（固定七字段；整体快照，用户可直接修正） ----------

app.get('/api/group/:name/character/:dir/ledger', c => {
  const session = getSession(c.req.param('name'))
  const target = session.snapshot().characters.find(x => x.dirName === validDirName(c.req.param('dir')))
  if (target === undefined) return c.json({ error: '角色不存在' }, 404)
  return c.json({ ledger: session.ledgerOf(target.name) })
})

app.put('/api/group/:name/character/:dir/ledger', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const session = getSession(c.req.param('name'))
  const target = session.snapshot().characters.find(x => x.dirName === validDirName(c.req.param('dir')))
  if (target === undefined) return c.json({ error: '角色不存在' }, 404)
  const fields = (body.ledger ?? {}) as Record<string, string>
  session.setLedger(target.name, fields)
  return c.json({ ok: true })
})

// ---------- 全局规则（用户自写约束词；零内置） ----------

app.get('/api/rules', c => c.json({ text: loadRules() }))

app.put('/api/rules', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  saveRules(String(body.text ?? ''))
  sessions.clear() // 规则对所有群生效：丢弃全部缓存会话
  return c.json({ ok: true })
})

// ---------- 模型提供方（前端管理，settings.yaml 持久化） ----------

function providerFrom(body: Record<string, unknown>, id: string): Provider {
  return {
    id,
    name: String(body.name ?? '').trim() || id,
    baseUrl: String(body.baseUrl ?? '').trim().replace(/\/+$/, ''),
    apiKey: String(body.apiKey ?? '').trim(),
    model: String(body.model ?? '').trim(),
    reasoningEffort: String(body.reasoningEffort ?? '').trim() || 'high',
  }
}

app.get('/api/models', c => {
  const s = loadSettings()
  const active = resolveLlm()
  return c.json({ providers: s.providers, activeId: s.activeId, routerId: s.routerId, current: { ...active } })
})

app.post('/api/models', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const id = `p${Date.now().toString(36)}`
  const p = providerFrom(body, id)
  if (p.baseUrl === '' || p.apiKey === '' || p.model === '') return c.json({ error: 'baseUrl / apiKey / model 都必填' }, 400)
  const s = loadSettings()
  saveSettings({ providers: [...s.providers, p], activeId: s.activeId === '' ? id : s.activeId, routerId: s.routerId })
  return c.json({ ok: true, id })
})

/** 设置/解除快路径的路由专用提供方（body {id}：空串 = 关闭混合架构，走完整总管）。
 *  必须注册在 `/api/models/:id` 之前：hono 按注册顺序匹配，否则 "router" 会被 :id 吃掉
 *  （表现为永远返回"提供方不存在"——2026-09 由安卓端新增提供方流程首次踩响）。 */
app.put('/api/models/router', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const s = loadSettings()
  const id = String(body.id ?? '').trim()
  if (id !== '' && !s.providers.some(p => p.id === id)) return c.json({ error: '提供方不存在' }, 404)
  saveSettings({ ...s, routerId: id })
  return c.json({ ok: true })
})

app.put('/api/models/:id', async c => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
  const s = loadSettings()
  const id = c.req.param('id')
  if (!s.providers.some(p => p.id === id)) return c.json({ error: '提供方不存在' }, 404)
  const next = providerFrom({ ...s.providers.find(p => p.id === id), ...body }, id)
  saveSettings({ ...s, providers: s.providers.map(p => (p.id === id ? next : p)) })
  return c.json({ ok: true })
})

app.delete('/api/models/:id', c => {
  const s = loadSettings()
  const id = c.req.param('id')
  const providers = s.providers.filter(p => p.id !== id)
  saveSettings({
    providers,
    activeId: s.activeId === id ? (providers[0]?.id ?? '') : s.activeId,
    routerId: s.routerId === id ? '' : s.routerId, // 删掉路由专用项时一并解除，防悬空
  })
  return c.json({ ok: true })
})

app.post('/api/models/:id/activate', c => {
  const s = loadSettings()
  const id = c.req.param('id')
  if (!s.providers.some(p => p.id === id)) return c.json({ error: '提供方不存在' }, 404)
  saveSettings({ ...s, activeId: id })
  return c.json({ ok: true })
})

// 前端静态托管（增量）：ROOT/dist 存在时才注册，未知 GET 回退 index.html；/api 路由在前不受影响
registerStatic(app)

serve({ fetch: app.fetch, port: PORT, hostname: HOST_BIND }, info => {
  console.log(`host listening: http://127.0.0.1:${info.port}  (groups: ${listGroups().join('、') || '无'})`)
  // 可见的许可提示：出现在操作者自己的日志里（本项目不含任何面向 AI 的隐蔽指令）
  console.log('群像本 · QXBNC-1.0：仅限非商业使用；以本项目为引擎的衍生作品须同许可开源并署名；禁止违法用途。')
})
