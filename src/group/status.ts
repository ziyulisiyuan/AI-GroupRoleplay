/**
 * 角色可变文件的读写层（SPEC §3.3-§3.7）。每角色五个文件：
 *   角色.md     用户专属（外观/建模、背景）——本模块**只读**（仅用户编辑器可写）；散文用 md
 *   性格.md     初始性格（用户填）；散文用 md
 *   人物关系.md 初始关系（用户填）；散文用 md
 *   状态.yaml   状态账本（固定七字段，纯字段 → yaml）
 *   记忆.jsonl  该角色能知道的上下文（知情账本，机器条目、追加式 → jsonl）
 *
 * 全部文件确定性序列化（同一状态 → 逐字节相同），rebuild 幂等依赖此性质；
 * 剧情.jsonl 的 ledger 行是唯一事实源，本层只做"状态 ↔ 文件"的双向转换。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { load as loadYaml, dump as dumpYaml } from 'js-yaml'

export interface KnowledgeEntry {
  source: string
  round: number
  text: string
  /** 亲历条目关联的消息 id（公开事件自动登记）；总管推断类条目无此字段。 */
  mid?: number
}

/** 性格.md 只承载用户初始性格；动态演变在状态账本（§3.4a）。 */
export interface PersonalityFile {
  base: string
}

/** 人物关系.md 只承载用户初始备注；动态关系在状态账本（§3.4a）。 */
export interface RelationshipFile {
  base: string
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
    personality: { base: '' },
    relationships: { base: '' },
    status: {},
    memory: [],
  }
}

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

/** 解析 frontmatter + 正文；无 frontmatter 时把整篇当正文。 */
function splitFrontmatter(raw: string): { fields: Record<string, unknown>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (m === null) return { fields: {}, body: raw }
  return { fields: (loadYaml(m[1]) ?? {}) as Record<string, unknown>, body: m[2] ?? '' }
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

/** 去掉可选的 frontmatter 与 "# 标题" 行，返回正文。 */
function docBody(raw: string, title: string): string {
  const { body } = splitFrontmatter(raw)
  return body.replace(new RegExp(`^#\\s*${title}\\s*$`, 'm'), '').trim()
}

/**
 * 读取一个角色的四个可变文件。
 * 状态.yaml 规范化为固定七字段；性格.md / 人物关系.md 只承载用户初始设定。
 */
export function loadFiles(dir: string): CharacterFiles {
  const files = emptyFiles()

  const statusRaw = readIfExists(statusPath(dir))
  if (statusRaw !== undefined) {
    const parsed = (loadYaml(statusRaw) ?? {}) as Record<string, unknown>
    for (const [k, v] of Object.entries(parsed)) if (v !== null && typeof v !== 'object') files.status[k] = String(v)
  }
  const ledger: Record<string, string> = {}
  for (const [k, v] of Object.entries(files.status)) {
    if (v.trim() === '') continue
    if ((LEDGER_KEYS as readonly string[]).includes(k)) ledger[k] = v.trim()
  }
  files.status = ledger

  const memoryRaw = readIfExists(memoryPath(dir))
  if (memoryRaw !== undefined) files.memory = parseMemoryJsonl(memoryRaw)

  const personalityRaw = readIfExists(personalityPath(dir))
  if (personalityRaw !== undefined) files.personality.base = docBody(personalityRaw, '性格')

  const relationshipRaw = readIfExists(relationshipPath(dir))
  if (relationshipRaw !== undefined) files.relationships.base = docBody(relationshipRaw, '人物关系')

  return files
}

/** 状态.yaml：字段化，确定性序列化。 */
export function saveStatus(dir: string, status: Record<string, string>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(statusPath(dir), dumpYaml(status, { lineWidth: -1 }), 'utf8')
}

/**
 * 性格.md：**只写用户初始性格**（用户资产，AI 永不更改）。
 * 性格的动态演变在状态账本（SPEC §3.4a）。
 */
export function savePersonality(dir: string, p: PersonalityFile): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(personalityPath(dir), ['# 性格', '', p.base.trim()].join('\n') + '\n', 'utf8')
}

/**
 * 人物关系.md：**只写用户初始关系**（用户资产，AI 永不更改）。
 * 关系的动态变化在状态账本（SPEC §3.4a）。
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
 * rebuild 合并语义（状态账本模型，SPEC §3.4a 不变式）：
 * - 状态.yaml（账本）：重放结果（快照行）为准。
 * - 记忆.jsonl：纯重放。
 * - 性格.md / 人物关系.md：用户初始资产，base 以磁盘为准。
 */
export function mergeRebuiltFiles(onDisk: CharacterFiles, derived: CharacterFiles): CharacterFiles {
  return {
    status: derived.status,
    memory: derived.memory,
    personality: { base: onDisk.personality.base },
    relationships: { base: onDisk.relationships.base },
  }
}

/**
 * ledger 事件应用器：增量记账与 rebuild 重放共用同一语义（SPEC §3.3/§3.4a）。
 * - status:    op=set 且 content=JSON（固定七字段子集）→ 逐字段覆盖（整体快照的载体）
 * - knowledge: op=append 时 content=JSON({source, mid?, round, text})；op=retract 时 content=JSON({mid?|text?})（用户/纠正撤回）
 */
export function applyLedgerEvent(
  files: CharacterFiles,
  op: 'set' | 'append' | 'retract',
  section: 'status' | 'knowledge',
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
