/**
 * 面具（SPEC §3.6a）：用户侧的另一副人设——换一副身份对场景里说话（马甲）。
 *
 * **面具不是角色**：没有目录、没有在场与位置、没有记忆与状态账本、不参与路由与判定候选；
 * 它只替换两样东西——角色每轮看到的「你是谁」，以及用户发言的署名（剧情.jsonl 的 msg.name）。
 * 戴上之前的消息与记忆保持原署名，一个字都不改。
 *
 * 归属本群：与 用户.md 同域，别的群读不到。
 * 配置语义：不进 剧情.jsonl、不参与 rebuild、不在轮次回退快照里（回退不摘面具）。
 *
 * 存储：groups/<群>/面具.jsonl（一行一面具，键序固定）+ 当前面具.yaml（{ current }）。
 *   { id, name, text }
 *   id   —— 稳定编号（改名不动它；当前面具按编号存，改名不会把「戴着」弄丢）
 *   name —— 称呼（= 角色看到的【和你对话的人】称呼与发言署名）
 *   text —— 设定正文（角色的「你是谁」段落）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dump as dumpYaml, load as loadYaml } from 'js-yaml'
import { isValidName } from './scaffold.ts'
import { loadCharacters } from './persona.ts'

export interface MaskItem {
  id: string
  name: string
  text: string
}

export const MASK_FILENAME = '面具.jsonl'
export const CURRENT_MASK_FILENAME = '当前面具.yaml'

export const maskPath = (groupDir: string): string => join(groupDir, MASK_FILENAME)
const currentMaskPath = (groupDir: string): string => join(groupDir, CURRENT_MASK_FILENAME)

/** 读取面具列表（纯读；坏行忽略——与 剧情.jsonl / 记忆.jsonl 同策略）。 */
export function loadMaskList(groupDir: string): MaskItem[] {
  const file = maskPath(groupDir)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .flatMap(l => {
      try {
        const j = JSON.parse(l) as { id?: unknown; name?: unknown; text?: unknown }
        const id = typeof j.id === 'string' ? j.id.trim() : ''
        const name = typeof j.name === 'string' ? j.name.trim() : ''
        if (id === '' || name === '') return []
        return [{ id, name, text: typeof j.text === 'string' ? j.text : '' }]
      } catch { return [] }
    })
}

/**
 * 整表保存（服务端侧逐条清洗与校验；任何一条不合格 → 抛错且**一个字都不写**）。
 * 规则（SPEC §3.6a）：编号非空且唯一、名字合法且面具之间唯一、**不得与任何角色重名**、
 * 正戴着的那副不能被删掉（先摘下再删）。
 */
export function saveMaskList(groupDir: string, list: ReadonlyArray<unknown>): void {
  const charNames = new Set(loadCharacters(groupDir).map(c => c.name))
  const ids = new Set<string>()
  const names = new Set<string>()
  const clean: MaskItem[] = []
  for (const raw of list) {
    const o = (raw ?? {}) as Record<string, unknown>
    const id = typeof o.id === 'string' ? o.id.trim() : ''
    if (id === '') throw new Error('面具缺少编号')
    if (ids.has(id)) throw new Error(`面具编号重复：${id}`)
    ids.add(id)
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!isValidName(name)) throw new Error('非法面具名')
    // 重名 = 判定层与记忆层分不清"这两个名字是谁"：引擎只认名字字符串，面具没有编号兜底
    if (charNames.has(name)) throw new Error(`面具名「${name}」与角色重名——面具不能和角色用同一个称呼`)
    if (names.has(name)) throw new Error(`面具之间不能重名：${name}`)
    names.add(name)
    clean.push({ id, name, text: typeof o.text === 'string' ? o.text : '' })
  }
  const current = loadCurrentMaskId(groupDir)
  if (current !== '' && !clean.some(m => m.id === current)) throw new Error('正戴着这副面具，先摘下再删除')
  writeFileSync(
    maskPath(groupDir),
    clean.length === 0 ? '' : clean.map(m => JSON.stringify({ id: m.id, name: m.name, text: m.text })).join('\n') + '\n',
    'utf8',
  )
}

/** 该名字是否已被面具占用——角色创建/改名时的**对称校验**用（面具侧在 saveMaskList 里拦角色名）。 */
export function maskNameTaken(groupDir: string, name: string): boolean {
  const n = name.trim()
  return n !== '' && loadMaskList(groupDir).some(m => m.name === n)
}

/** 当前面具编号（'' = 未戴；文件缺失/坏文件同样按未戴）。 */
export function loadCurrentMaskId(groupDir: string): string {
  const file = currentMaskPath(groupDir)
  if (!existsSync(file)) return ''
  try {
    const raw = (loadYaml(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) ?? {}) as Record<string, unknown>
    return typeof raw.current === 'string' ? raw.current.trim() : ''
  } catch { return '' }
}

/** 戴上（id）或摘下（''）。编号必须是现存面具——否则抛错（不改盘）。 */
export function setCurrentMask(groupDir: string, id: string): void {
  const target = id.trim()
  if (target !== '' && !loadMaskList(groupDir).some(m => m.id === target)) throw new Error(`面具不存在: ${target}`)
  writeFileSync(currentMaskPath(groupDir), dumpYaml({ current: target }, { lineWidth: -1 }), 'utf8')
}

/** 当前面具（未戴 / 悬空编号 → null）：悬空按未戴处理，不写盘自愈（文件可能被手工改坏）。 */
export function currentMask(groupDir: string): MaskItem | null {
  const id = loadCurrentMaskId(groupDir)
  if (id === '') return null
  return loadMaskList(groupDir).find(m => m.id === id) ?? null
}
