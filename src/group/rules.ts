/**
 * 全局规则（SPEC §3.7）：用户自写的约束词/写作规则，**不内置任何内容**。
 * 多条规则存于工作区根 规则.jsonl，一行一条 {id, name, enabled, text}（键序固定，确定性序列化）：
 * name/enabled 是纯前端语义（列表显示名与启停拨片），text 才会注入。
 * loadRules() 返回所有**已开启**规则正文的拼接（列表序；空文本跳过；全关/无规则 = 空串）——
 * 注入对象：每一个角色（在末尾指令之前）；判定/记账/纠正等后台 AI 不消费此文件。
 * 规则.md（单文件格式）同样受支持：规则.jsonl 不存在时，其内容作为一条开启规则参与读取；
 * 规则页 GET 端点会把该内容落盘为 规则.jsonl（幂等）。文件缺失/为空/全关 = 不注入任何规则。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.ts'

export const RULES_FILENAME = '规则.md'
export const RULES_LIST_FILENAME = '规则.jsonl'

export interface RuleItem {
  id: string
  /** 显示名（纯前端标签，不进任何提示词）。 */
  name: string
  enabled: boolean
  text: string
}

export const rulesListPath = (root: string = config.root): string => join(root, RULES_LIST_FILENAME)

/** 读取规则列表（**纯读**，永不写盘）：jsonl 存在用 jsonl；否则 规则.md（单文件格式）的内容作为一条开启规则返回。 */
export function loadRuleList(root: string = config.root): RuleItem[] {
  const file = rulesListPath(root)
  if (!existsSync(file)) {
    const legacy = loadLegacyRuleText(root)
    if (legacy === '') return []
    return [{ id: 'legacy', name: '全局规则', enabled: true, text: legacy }]
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .flatMap(l => {
      try {
        const j = JSON.parse(l) as { id?: unknown; name?: unknown; enabled?: unknown; text?: unknown }
        if (typeof j.id !== 'string' || j.id === '' || typeof j.text !== 'string') return [] // 坏行忽略
        return [{
          id: j.id,
          name: typeof j.name === 'string' && j.name.trim() !== '' ? j.name.trim() : '未命名规则',
          enabled: j.enabled === true,
          text: j.text,
        }]
      } catch { return [] }
    })
}

/** 把 规则.md 的内容落盘为 规则.jsonl（幂等：jsonl 已存在则跳过；仅规则页 GET 端点调用——引擎读取路径纯读）。 */
export function ensureRuleMigration(root: string = config.root): void {
  if (existsSync(rulesListPath(root))) return
  const legacy = loadLegacyRuleText(root)
  if (legacy === '') return
  writeRuleListFile(root, [{ id: `r${Date.now().toString(36)}`, name: '全局规则', enabled: true, text: legacy }])
}

/** 保存规则列表（整表覆盖；服务端侧逐条清洗，id 为空的条目丢弃）。 */
export function saveRuleList(list: ReadonlyArray<unknown>, root: string = config.root): void {
  const clean: RuleItem[] = list.flatMap(r => {
    const o = (r ?? {}) as Record<string, unknown>
    if (typeof o.id !== 'string' || o.id.trim() === '') return []
    const text = typeof o.text === 'string' ? o.text : ''
    const name = typeof o.name === 'string' && o.name.trim() !== '' ? o.name.trim() : '未命名规则'
    return [{ id: o.id.trim(), name, enabled: o.enabled === true, text }]
  })
  writeRuleListFile(root, clean)
}

/** 已开启规则正文的拼接（列表序，空文本跳过）；无 = 空串（不注入任何规则）。 */
export function loadRules(root: string = config.root): string {
  return loadRuleList(root)
    .filter(r => r.enabled && r.text.trim() !== '')
    .map(r => r.text.trim())
    .join('\n\n')
}

/** 规则.md（单文件格式）的正文（剥离可选 frontmatter）；不存在/为空返回空串。 */
function loadLegacyRuleText(root: string): string {
  const file = join(root, RULES_FILENAME)
  if (!existsSync(file)) return ''
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/)
  return (m === null ? raw : m[1]).trim()
}

function writeRuleListFile(root: string, list: ReadonlyArray<RuleItem>): void {
  writeFileSync(
    rulesListPath(root),
    list.length === 0 ? '' : list.map(r => JSON.stringify({ id: r.id, name: r.name, enabled: r.enabled, text: r.text })).join('\n') + '\n',
    'utf8',
  )
}
