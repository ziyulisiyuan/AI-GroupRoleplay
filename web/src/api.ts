/**
 * 与后端的镜像契约（SPEC §7.5）：这里的类型是后端类型的孪生——
 * 后端改名而不同步这里，UI 会静默坏掉。
 * 源标签（亲历/额外得知/现场所见/用户指定/推断/他人告知）、层名（现场/接入/单向感知）、
 * 感知值（语音/视听）是字面系统标识符，逐字显示，禁止翻译或别名。
 */
export interface Msg {
  type: 'msg'
  id: number
  role: 'user' | 'character' | 'system'
  name: string
  text: string
  round: number
  visible_to: 'all' | string[]
  ts: string
}
export interface Route { type: 'route'; round: number; picked: string; reason: string; fallback: boolean }
export interface Character { name: string; dirName: string }
export interface RemoteLink { character: string; perceive: '语音' | '视听'; note?: string; since?: number }
export interface Scene { name: string; description: string }
export interface Snapshot {
  name: string
  era: string
  world: string
  tone: string
  scene: string
  scenes: Scene[]
  userName: string
  present: string[]
  remote: RemoteLink[]
  overhear: RemoteLink[]
  absent: string[]
  characters: Character[]
  messages: Msg[]
  routes: Route[]
}
export interface Draft { name: string; appearance: string; background: string; personality: string; relationships: string; scene?: string }
export interface Provider { id: string; name: string; baseUrl: string; apiKey: string; model: string; reasoningEffort: string }
export interface ModelsInfo { providers: Provider[]; activeId: string; routerId: string; current: { baseUrl: string; apiKey: string; model: string; reasoningEffort: string; source: string } }
/** SessionEvent 的孪生（engine.ts）。 */
export type Ev =
  | { type: 'speaker'; name: string }
  | { type: 'delta'; text: string }
  | { type: 'route'; picked: string; reason: string; fallback: boolean }
  | { type: 'reply'; name: string; text: string }
  | { type: 'ledger'; text: string }
  | { type: 'info'; text: string }
export interface MemoryEntry { index: number; source: string; round: number; text: string }
export type JudgeRow = { ts?: string; phase?: string } & Record<string, unknown>

export const enc = encodeURIComponent

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init)
  if (!r.ok) {
    const j = await r.json().catch(() => ({}) as { error?: string }) as { error?: string }
    throw new Error(j.error ?? `HTTP ${r.status}`)
  }
  return await r.json() as T
}
export const getJson = <T,>(p: string): Promise<T> => req<T>(p)
export const postJson = <T,>(p: string, body: unknown): Promise<T> => req<T>(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
export const putJson = <T,>(p: string, body: unknown): Promise<T> => req<T>(p, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
export const delJson = <T,>(p: string): Promise<T> => req<T>(p, { method: 'DELETE' })
export const putBytes = async (p: string, blob: Blob): Promise<void> => {
  const r = await fetch(p, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: blob })
  if (!r.ok) {
    const j = await r.json().catch(() => ({}) as { error?: string }) as { error?: string }
    throw new Error(j.error ?? `HTTP ${r.status}`)
  }
}

/**
 * NDJSON 事件流：必须读到流尾（服务器无论客户端断连都会把生成器跑完，
 * SPEC §7.5——中途出错也要继续读，结束后由调用方重拉快照）。
 */
export async function readNdjson(res: Response, onEvent: (ev: Ev) => void): Promise<void> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line !== '') onEvent(JSON.parse(line) as Ev)
    }
  }
}

export const postStream = async (group: string, path: string, body: unknown): Promise<Response> => {
  const r = await fetch(`/api/group/${enc(group)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const j = await r.json().catch(() => ({}) as { error?: string }) as { error?: string }
    throw new Error(j.error ?? `HTTP ${r.status}`)
  }
  return r
}

/** 头像地址（视觉专用，永不进模型输入；v = 版本号用于更新后破缓存）。 */
export function avatarUrl(group: string, kind: 'group' | 'user' | `char:${string}`, v: number): string {
  const base = `/api/group/${enc(group)}`
  const p = kind === 'group' ? `${base}/avatar`
    : kind === 'user' ? `${base}/user/avatar`
      : `${base}/character/${enc(kind.slice(5))}/avatar`
  return `${p}?v=${v}`
}

/** 群列表行：主页预览需要每群的最后一条消息。 */
export interface GroupRow { name: string; preview: string; ts: number }
export async function loadGroupRows(): Promise<GroupRow[]> {
  const { groups } = await getJson<{ groups: string[] }>('/api/groups')
  const rows = await Promise.all(groups.map(async name => {
    try {
      const s = await getJson<Snapshot>(`/api/group/${enc(name)}`)
      const last = s.messages[s.messages.length - 1]
      return {
        name,
        preview: last === undefined ? '（还没有消息）' : `${last.name}：${last.text.replace(/\s+/g, ' ')}`,
        ts: last === undefined ? 0 : Date.parse(last.ts),
      }
    } catch {
      return { name, preview: '（打开失败）', ts: 0 }
    }
  }))
  return rows.sort((a, b) => b.ts - a.ts)
}
