/**
 * 轮次回退（SPEC §1.4）：每一轮发言开始时给**剧情状态**拍一张快照，回退 = 把这张快照整份盖回去。
 *
 * 为什么不"按行截断 + 反向记账"：用户在轮内还会删对话、改消息、重掷、手改账本——这些东西
 * 没有统一的追加式记录，逐条反演极易漏项。整份快照对任何改动都成立，只有代价：
 * 每轮开始复制一次（压缩后通常几十毫秒），并且只能回退**最近 N 轮**（旧快照按数量淘汰）。
 *
 * 快照内容（剧情状态）：剧情.jsonl · 在场.yaml · 任务书.jsonl · 思维链.jsonl ·
 * 每个角色的 状态.yaml / 记忆.jsonl。
 * **配置类文件不在快照里**：角色.md / 性格.md / 人物关系.md / 知识库.md / 用户.md /
 * 群设定.yaml / 场景/ / 头像 —— 回退不碰它们（角色改名例外，见下）。
 *
 * 改名例外：改名会在剧情日志里追加一行 旧名→新名 映射（名字链），而人设文件不在快照里。
 * 若回退把映射行带走、文件却留着新名字，旧账目就归错人。所以还原时**保留本轮新增的改名行**，
 * 让映射继续生效——改名的效果不回退，账目也不会乱。
 *
 * 消息 id 永不复用：还原后 header.lastMsgId 取"快照值"与"当前值"的较大者。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { loadCharacters } from './persona.ts'

/** 保留最近多少轮快照（超出按时间淘汰最旧的）。 */
export const UNDO_KEEP = 10

const undoDir = (groupDir: string): string => join(groupDir, '.undo')

interface StoryLineLike {
  type?: string
  id?: number
  role?: string
  text?: string
  from?: string
  to?: string
  ts?: string
  lastMsgId?: number
}

interface Bundle {
  v: 1
  round: number
  ts: string
  /** 拍快照时的 header.lastMsgId：判"这一轮新增的消息"（取回你被删掉的那句话）用。 */
  lastMsgId: number
  /** 相对群目录的路径 → 文件内容（null = 当时不存在）。 */
  files: Record<string, string | null>
}

/** 快照覆盖的文件清单（配置类文件刻意不在其中）。 */
function snapshotPaths(groupDir: string): string[] {
  const paths = ['剧情.jsonl', '在场.yaml', '任务书.jsonl', '思维链.jsonl']
  for (const c of loadCharacters(groupDir)) {
    paths.push(`角色/${c.dirName}/状态.yaml`, `角色/${c.dirName}/记忆.jsonl`)
  }
  return paths
}

function parseLines(raw: string): StoryLineLike[] {
  return raw
    .split('\n')
    .filter(l => l.trim() !== '')
    .flatMap(l => { try { return [JSON.parse(l) as StoryLineLike] } catch { return [] } })
}

function headerOf(lines: StoryLineLike[]): StoryLineLike | undefined {
  return lines[0]?.type === 'header' ? lines[0] : undefined
}

/** 拍一张快照（每轮发言开始时调用；失败抛错，由调用方吞掉并记日志）。 */
export function snapshotRound(groupDir: string, round: number): void {
  const files: Record<string, string | null> = {}
  for (const rel of snapshotPaths(groupDir)) {
    const p = join(groupDir, rel)
    files[rel] = existsSync(p) ? readFileSync(p, 'utf8') : null
  }
  const logRaw = files['剧情.jsonl'] ?? ''
  const lastMsgId = headerOf(parseLines(logRaw))?.lastMsgId ?? 0
  const bundle: Bundle = { v: 1, round, ts: new Date().toISOString(), lastMsgId, files }
  const dir = undoDir(groupDir)
  mkdirSync(dir, { recursive: true })
  let ms = Date.now()
  let name = ''
  for (;;) {
    name = `${String(ms).padStart(13, '0')}-r${round}.json.gz`
    if (!existsSync(join(dir, name))) break
    ms++
  }
  writeFileSync(join(dir, name), gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8')))
  prune(groupDir)
}

/** 现存的快照（新 → 旧）。 */
export function listSnapshots(groupDir: string): Array<{ file: string; round: number }> {
  const dir = undoDir(groupDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.json.gz'))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
    .flatMap(f => {
      const m = /-r(\d+)\.json\.gz$/.exec(f)
      return [{ file: f, round: m === null ? 0 : Number(m[1]) }]
    })
}

function prune(groupDir: string): void {
  const list = listSnapshots(groupDir)
  for (const s of list.slice(UNDO_KEEP)) rmSync(join(undoDir(groupDir), s.file), { force: true })
}

export interface UndoInfo {
  /** 还能回退几轮。 */
  remaining: number
  /** 下一次回退会撤掉第几轮（没有快照 = null）。 */
  round: number | null
}

export function undoInfo(groupDir: string): UndoInfo {
  const list = listSnapshots(groupDir)
  return { remaining: list.length, round: list[0]?.round ?? null }
}

/**
 * 回退最近一轮：把最近一张快照整份盖回去，然后消耗掉这张快照（下一张仍在，可继续回退）。
 * 返回被撤掉的那一轮的序号与**你那句话的原文**（轮内被你删掉时为空串）。
 */
export function restoreLastRound(groupDir: string): { round: number; text: string } | undefined {
  const list = listSnapshots(groupDir)
  const top = list[0]
  if (top === undefined) return undefined
  const file = join(undoDir(groupDir), top.file)
  let bundle: Bundle
  try {
    bundle = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as Bundle
  } catch {
    rmSync(file, { force: true }) // 坏包：删掉，别把回退按钮卡死
    return undefined
  }
  const logPath = join(groupDir, '剧情.jsonl')
  const curLines = existsSync(logPath) ? parseLines(readFileSync(logPath, 'utf8')) : []
  const restoredLines = parseLines(bundle.files['剧情.jsonl'] ?? '')
  // 消息 id 永不复用：取当前与快照的较大值（被撤掉那轮用掉的 id 也算数）
  const curLastId = Math.max(
    headerOf(curLines)?.lastMsgId ?? 0,
    ...curLines.filter(l => l.type === 'msg' && typeof l.id === 'number').map(l => l.id as number),
  )
  // 本轮那句话（快照之后的第一条用户消息）——给你回填输入框用
  const userLine = curLines.find(l => l.type === 'msg' && l.role === 'user' && typeof l.id === 'number' && (l.id as number) > bundle.lastMsgId)
  // 改名行保留：人设文件不在快照里，映射不能丢
  const hasRename = (l: StoryLineLike): boolean => restoredLines.some(x => x.type === 'rename' && x.from === l.from && x.to === l.to && x.ts === l.ts)
  const carried = curLines.filter(l => l.type === 'rename' && !hasRename(l))
  const merged = [...restoredLines, ...carried]
  const header = headerOf(merged)
  if (header !== undefined) header.lastMsgId = Math.max(bundle.lastMsgId, curLastId)

  for (const [rel, content] of Object.entries(bundle.files)) {
    const p = join(groupDir, rel)
    if (content === null) {
      if (existsSync(p)) rmSync(p, { force: true })
      continue
    }
    if (rel === '剧情.jsonl') {
      writeFileSync(p, merged.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8')
      continue
    }
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  rmSync(file, { force: true }) // 这张快照已被消耗；更旧的仍在
  return { round: bundle.round, text: userLine?.text ?? '' }
}
