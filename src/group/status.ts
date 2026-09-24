/**
 * 角色可变文件的读写层（SPEC §3.3-§3.7）。每角色五个文件：
 *   角色.md     用户专属（外观/建模、背景）——本模块**只读**（仅用户编辑器可写）；散文用 md
 *   性格.md     初始性格（用户填）+ "## 性格演变"（总管追加，不改写原文）；散文用 md
 *   人物关系.md 初始关系（用户填）+ 条目式增改（总管可新增/改写，不改写用户备注）；散文用 md
 *   状态.yaml   身体状况/增益/减益/心理（总管实时，纯字段 → yaml）
 *   记忆.jsonl  该角色能知道的上下文（知情账本，机器条目、追加式 → jsonl）
 *
 * 全部文件确定性序列化（同一状态 → 逐字节相同），rebuild 幂等依赖此性质；
 * 剧情.jsonl 的 ledger 行是唯一事实源，本层只做"状态 ↔ 文件"的双向转换。
 * 旧格式（状态.md / 记忆.md、性格与关系写在 角色.md）在读取时自动迁移并删除旧文件。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml, dump as dumpYaml } from 'js-yaml'

export interface KnowledgeEntry {
  source: string
  round: number
  text: string
  /** 亲历条目关联的消息 id（公开事件自动登记）；总管推断类条目无此字段。 */
  mid?: number
}

export interface PersonalityFile {
  /** 用户填写的初始性格（总管不改写）。 */
  base: string
  /** 性格演变（总管随剧情追加）。 */
  drift: Array<{ round: number; change: string }>
}

export interface RelationshipFile {
  /** 用户填写的自由备注（总管不改写）。 */
  base: string
  /** 关系条目：对象 → 描述。总管可新增条目或改写某条描述。 */
  entries: Array<{ target: string; text: string }>
}

/**
 * 状态账本（SPEC §3.4）：角色一切动态变化的**唯一**存放处，固定七字段、整体快照语义。
 * 初始设定（姓名/外观/背景/性格/关系）全部在用户编辑器里，AI 永不更改；
 * AI（慢路径记账/纠正窗口）只能对账本做"整体快照更新"——输出最新版，不做增量叠加。
 */
export const LEDGER_KEYS = ['生理状态', '心理状态', '外观状态', '位置状态', '性格演变', '姓名变化', '人物关系变化'] as const
export type LedgerKey = (typeof LEDGER_KEYS)[number]
export type LedgerFields = Partial<Record<LedgerKey, string>>

/** 从任意对象里挑出合法的账本字段（字符串、去空白；空串视为未提供）。 */
export function pickLedgerFields(obj: Record<string, unknown>): LedgerFields {
  const out: LedgerFields = {}
  for (const k of LEDGER_KEYS) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim()
  }
  return out
}

/** 把账本渲染成角色 prompt 片段（固定格式；空字段显示"无"）。 */
export function ledgerPrompt(status: Record<string, string>): string {
  const lines = LEDGER_KEYS.map(k => `${k}:"${status[k]?.trim() || '无'}"`)
  return `【你当前的状态账本（你此刻的最新状态，以此为准；与更早的对话内容冲突时，以这里为准）】\n${lines.join('\n')}`
}

/** 一个角色除只读 角色.md 之外的全部可变文件。 */
export interface CharacterFiles {
  personality: PersonalityFile
  relationships: RelationshipFile
  status: Record<string, string>
  memory: KnowledgeEntry[]
}

export function emptyFiles(): CharacterFiles {
  return {
    personality: { base: '', drift: [] },
    relationships: { base: '', entries: [] },
    status: {},
    memory: [],
  }
}

const DRIFT_HEADER = '## 性格演变'
const OLD_KNOWLEDGE_HEADER = '## 知情账本'

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

function readIfExists(file: string): string | undefined {
  return existsSync(file) ? stripBom(readFileSync(file, 'utf8')) : undefined
}

// 机器独占的数据用 yaml/jsonl；给人写的散文用 md（SPEC §3.3-§3.7）
export const statusPath = (dir: string): string => join(dir, '状态.yaml')
export const memoryPath = (dir: string): string => join(dir, '记忆.jsonl')
export const personalityPath = (dir: string): string => join(dir, '性格.md')
export const relationshipPath = (dir: string): string => join(dir, '人物关系.md')
/** 旧格式（迁移用）：状态字段内嵌在 md 的 frontmatter、记忆为管道分隔的 md 列表 */
const legacyStatusPath = (dir: string): string => join(dir, '状态.md')
const legacyMemoryPath = (dir: string): string => join(dir, '记忆.md')

/** 解析 frontmatter + 正文；无 frontmatter 时把整篇当正文。 */
function splitFrontmatter(raw: string): { fields: Record<string, unknown>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (m === null) return { fields: {}, body: raw }
  return { fields: (loadYaml(m[1]) ?? {}) as Record<string, unknown>, body: m[2] ?? '' }
}

/** 旧格式：管道分隔的 md 记忆条目 */
function parseLegacyKnowledgeLines(text: string): KnowledgeEntry[] {
  const out: KnowledgeEntry[] = []
  for (const line of text.split('\n')) {
    const km = line.match(/^-\s*(K\d+)\s*\|\s*source=([^|]+)\|\s*(?:mid=(\d+)\s*\|\s*)?round=(\d+)\s*\|\s*(.+)$/)
    if (km !== null) {
      out.push({
        source: km[2].trim(),
        ...(km[3] !== undefined ? { mid: Number(km[3]) } : {}),
        round: Number(km[4]),
        text: km[5].trim(),
      })
    }
  }
  return out
}

/** 记忆.jsonl：逐行 JSON（追加式机器条目）。 */
function parseMemoryJsonl(raw: string): KnowledgeEntry[] {
  const out: KnowledgeEntry[] = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (s === '') continue
    try {
      const j = JSON.parse(s) as { source?: string; round?: number; text?: string; mid?: number }
      if (typeof j.text === 'string' && j.text !== '') {
        out.push({
          source: j.source ?? '亲历',
          ...(typeof j.mid === 'number' ? { mid: j.mid } : {}),
          round: typeof j.round === 'number' ? j.round : 0,
          text: j.text,
        })
      }
    } catch {
      // 坏行忽略（与剧情.jsonl 尾部半行同策略）
    }
  }
  return out
}

/** 解析 `- 对象：描述` 形式的关系条目；其余非标题文本视为用户备注。 */
function parseRelationshipBody(body: string): RelationshipFile {
  const entries: Array<{ target: string; text: string }> = []
  const notes: string[] = []
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line === '' || /^#/.test(line)) continue
    const em = line.match(/^-\s*([^：:]+)[：:]\s*(.+)$/)
    if (em !== null) entries.push({ target: em[1].trim(), text: em[2].trim() })
    else notes.push(line)
  }
  return { base: notes.join('\n').trim(), entries }
}

/**
 * 读取一个角色的四个可变文件；命中旧格式（状态.md / 记忆.md）则自动迁移并删除旧文件。
 * 状态账本模型（SPEC §3.4）：状态.yaml 规范化为固定七字段；性格.md 的旧"演变"列表与
 * 人物关系.md 的旧 AI 条目**一次性播种**进账本（内容不丢），此后这两个文件只承载用户初始设定。
 */
export function loadFiles(dir: string): CharacterFiles {
  const files = emptyFiles()
  let migrated = false

  // 状态：状态.yaml 优先；否则从旧 状态.md 迁移（含内嵌的旧知情账本）
  const statusRaw = readIfExists(statusPath(dir))
  if (statusRaw !== undefined) {
    const parsed = (loadYaml(statusRaw) ?? {}) as Record<string, unknown>
    for (const [k, v] of Object.entries(parsed)) if (v !== null && typeof v !== 'object') files.status[k] = String(v)
  } else {
    const legacyRaw = readIfExists(legacyStatusPath(dir))
    if (legacyRaw !== undefined) {
      const { fields, body } = splitFrontmatter(legacyRaw)
      for (const [k, v] of Object.entries(fields)) files.status[k] = String(v)
      if (body.includes(OLD_KNOWLEDGE_HEADER) && !existsSync(memoryPath(dir)) && !existsSync(legacyMemoryPath(dir))) {
        const section = body.slice(body.indexOf(OLD_KNOWLEDGE_HEADER) + OLD_KNOWLEDGE_HEADER.length)
        files.memory = parseLegacyKnowledgeLines(section)
        saveMemory(dir, files.memory)
      }
      rmSync(legacyStatusPath(dir), { force: true })
      migrated = true
    }
  }

  // 账本规范化：分离固定七字段与旧字段；旧字段按语义播种（身体类→生理，心理/情绪类→心理，其余并入生理）
  const ledger: Record<string, string> = {}
  const legacyKeys: Array<[string, string]> = []
  for (const [k, v] of Object.entries(files.status)) {
    if (v.trim() === '') continue
    if ((LEDGER_KEYS as readonly string[]).includes(k)) ledger[k] = v.trim()
    else legacyKeys.push([k, v.trim()])
  }
  for (const [k, v] of legacyKeys) {
    const target = /心理|心情|情绪|精神/.test(k) ? '心理状态' : '生理状态'
    ledger[target] = ledger[target] === undefined ? `${k}：${v}` : `${ledger[target]}；${k}：${v}`
  }
  if (legacyKeys.length > 0) migrated = true
  files.status = ledger

  // 记忆：记忆.jsonl 优先；否则从旧 记忆.md 迁移
  const memoryRaw = readIfExists(memoryPath(dir))
  if (memoryRaw !== undefined) {
    files.memory = parseMemoryJsonl(memoryRaw)
  } else {
    const legacyMemoryRaw = readIfExists(legacyMemoryPath(dir))
    if (legacyMemoryRaw !== undefined) {
      files.memory = parseLegacyKnowledgeLines(legacyMemoryRaw)
      saveMemory(dir, files.memory)
      rmSync(legacyMemoryPath(dir), { force: true })
    }
  }

  // 性格：base 是用户初始设定；旧"演变"列表一次性播种进账本（性格演变字段），文件回归纯初始
  const personalityRaw = readIfExists(personalityPath(dir))
  if (personalityRaw !== undefined) {
    const { body } = splitFrontmatter(personalityRaw)
    const idx = body.indexOf(DRIFT_HEADER)
    const base = (idx >= 0 ? body.slice(0, idx) : body).replace(/^#\s*性格\s*$/m, '').trim()
    const driftText = idx >= 0 ? body.slice(idx + DRIFT_HEADER.length) : ''
    const drift = driftText.split('\n').flatMap(line => {
      const dm = line.match(/^-\s*\(第(\d+)轮\)\s*(.+)$/)
      return dm !== null ? [{ round: Number(dm[1]), change: dm[2].trim() }] : []
    })
    files.personality = { base, drift: [] }
    if (drift.length > 0 && ledger['性格演变'] === undefined) {
      ledger['性格演变'] = drift.map(d => `第${d.round}轮起：${d.change}`).join('；')
      migrated = true
    }
  }

  // 人物关系：base/备注是用户初始设定；旧 AI 条目一次性播种进账本（人物关系变化字段）
  const relationshipRaw = readIfExists(relationshipPath(dir))
  if (relationshipRaw !== undefined) {
    const parsed = parseRelationshipBody(splitFrontmatter(relationshipRaw).body)
    files.relationships = { base: parsed.base, entries: [] }
    if (parsed.entries.length > 0 && ledger['人物关系变化'] === undefined) {
      ledger['人物关系变化'] = parsed.entries.map(e => `对${e.target}：${e.text}`).join('；')
      migrated = true
    }
  }

  // 播种/规范化结果落盘（一次性迁移；幂等——已规范化的文件不会再触发写入）
  if (migrated) saveStatus(dir, files.status)

  return files
}

/** 状态.yaml：字段化，确定性序列化。 */
export function saveStatus(dir: string, status: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(statusPath(dir), dumpYaml(status, { lineWidth: -1 }), 'utf8')
}

/**
 * 性格.md：**只写用户初始性格**（用户资产，AI 永不更改）。
 * 性格的动态演变已移入状态账本（SPEC §3.4），本文件不再承载演变。
 */
export function savePersonality(dir: string, p: PersonalityFile): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(personalityPath(dir), ['# 性格', '', p.base.trim()].join('\n') + '\n', 'utf8')
}

/**
 * 人物关系.md：**只写用户初始关系**（用户资产，AI 永不更改）。
 * 关系的动态变化已移入状态账本（SPEC §3.4）。
 */
export function saveRelationships(dir: string, r: RelationshipFile): void {
  mkdirSync(dir, { recursive: true })
  const lines = ['# 人物关系', '']
  if (r.base.trim() !== '') lines.push(r.base.trim(), '')
  writeFileSync(relationshipPath(dir), lines.join('\n') + '\n', 'utf8')
}

/** 记忆.jsonl：追加式机器条目，一行一条（键序固定，确定性）。 */
export function saveMemory(dir: string, memory: KnowledgeEntry[]): void {
  mkdirSync(dir, { recursive: true })
  const lines = memory.map(k => JSON.stringify({
    source: k.source,
    ...(k.mid === undefined ? {} : { mid: k.mid }),
    round: k.round,
    text: k.text,
  }))
  writeFileSync(memoryPath(dir), lines.length === 0 ? '' : lines.join('\n') + '\n', 'utf8')
}

/** 初始性格 → prompt 片段（动态演变在状态账本里，另行注入）。 */
export function personalityPrompt(p: PersonalityFile): string {
  return p.base
}

/** 初始人物关系 → prompt 片段（动态变化在状态账本里，另行注入）。 */
export function relationshipsPrompt(r: RelationshipFile): string {
  return r.base
}

/**
 * rebuild 合并语义（状态账本模型，SPEC §3.8 不变式）：
 * - 状态.yaml（账本）：重放结果（新式快照行）为准；性格/关系文件只保留用户初始部分。
 * - 记账.jsonl：纯重放。
 * - 性格.md / 人物关系.md：AI 永不更改的用户资产，base 以磁盘为准；旧的演变/条目已播种进账本，不再产出。
 */
export function mergeRebuiltFiles(onDisk: CharacterFiles, derived: CharacterFiles): CharacterFiles {
  return {
    status: derived.status,
    memory: derived.memory,
    personality: { base: onDisk.personality.base, drift: [] },
    relationships: { base: onDisk.relationships.base, entries: [] },
  }
}

/**
 * ledger 事件应用器：增量记账与 rebuild 重放共用同一语义（状态账本模型，SPEC §3.3/§3.4）。
 * - status:       op=set 且 content=JSON（固定七字段子集）→ 逐字段覆盖（整体快照的载体）；旧式"字段=值"/unset 行忽略（已播种）
 * - knowledge:    op=append 时 content=JSON({source, mid?, round, text})；op=retract 时 content=JSON({mid?|text?})（用户/纠正撤回）
 * - personality / relationship 旧段落：已退役，重放忽略（内容经播种进入状态账本）
 */
export function applyLedgerEvent(
  files: CharacterFiles,
  op: 'set' | 'append' | 'unset' | 'retract',
  section: 'status' | 'knowledge' | 'personality' | 'relationship',
  content: string,
  round: number,
): void {
  if (section === 'knowledge' && op === 'retract') {
    const q = JSON.parse(content) as { mid?: number; text?: string }
    files.memory = files.memory.filter(e =>
      !((typeof q.mid === 'number' && e.mid === q.mid) || (typeof q.text === 'string' && q.text !== '' && e.text === q.text)),
    )
    return
  }
  if (section === 'status') {
    // 新式快照行：content = JSON（固定七字段的子集，逐字段覆盖、其余保持）。
    // 旧式行（"字段=值"/unset）与 personality/relationship 旧段落：内容已经 loadFiles 播种进账本，重放时忽略。
    if (op !== 'set') return
    let parsed: Record<string, unknown>
    try { parsed = JSON.parse(content) as Record<string, unknown> } catch { return }
    if (Array.isArray(parsed) || typeof parsed !== 'object' || parsed === null) return
    for (const k of LEDGER_KEYS) {
      const v = parsed[k]
      if (typeof v === 'string') files.status[k] = v.trim()
    }
    return
  }
  if (section === 'personality' || section === 'relationship') return // 已退役：内容经播种进入状态账本（§3.4）
  const parsed = JSON.parse(content) as { source?: string; round?: number; text?: string; mid?: number }
  if (typeof parsed.text === 'string' && parsed.text !== '') {
    files.memory.push({
      source: parsed.source ?? '亲历',
      ...(typeof parsed.mid === 'number' ? { mid: parsed.mid } : {}),
      round: parsed.round ?? round,
      text: parsed.text,
    })
  }
}
