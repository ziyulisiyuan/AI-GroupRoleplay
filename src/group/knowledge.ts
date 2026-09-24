/**
 * 记忆（知情账本）运行时（SPEC §4.3/§5）：
 * - backfillKnowledge：凡 `visible_to` 可见（= Jev 判定的知情名单）且账本尚无该 mid 的消息，
 *   把**原文原样**移植进该角色的账本（不做任何总结改写——总结是虚构的唯一入口，实测踩过）。
 *   **返回新增条目**，调用方必须为其写 ledger 行（jsonl 是唯一事实源）。
 * - buildMemory：把账本条目按轮次、最新优先注入角色输入（按字符预算），
 *   已在"最近消息窗口"里的条目不重复注入。
 * 纯代码规则，无 LLM 参与；判定（谁该知道）由 Jev 完成，这里只做确定性移植。
 */
import { config } from '../config.ts'
import type { MsgLine, StoryStore } from '../store.ts'
import type { KnowledgeEntry } from './status.ts'

/** 消息对角色可见（SPEC §4.3 可见性规则）。 */
function visibleTo(m: MsgLine, name: string): boolean {
  return m.visible_to === 'all' || m.visible_to.includes(name)
}

/**
 * 账本条目文本 = 该角色视角下的**原文**（他人发言 `名：原文`；自己的发言 `你自己说过：原文`）。
 * 只加说话人标识，不做截断、概括或任何改写。
 */
export function witnessSummary(m: MsgLine, viewerName: string): string {
  return m.name === viewerName && m.role === 'character'
    ? `你自己说过：${m.text}`
    : `${m.name}：${m.text}`
}

/**
 * 登记"该角色可见但尚未入账"的消息为亲历条目（原文移植），返回新增部分。
 * suppressed：被用户手动撤回过的 mid（撤回后不得因回填而复现）。
 */
export function backfillKnowledge(
  store: StoryStore,
  name: string,
  memory: KnowledgeEntry[],
  suppressed: ReadonlySet<number> = new Set(),
): KnowledgeEntry[] {
  const known = new Set(memory.filter(k => k.mid !== undefined).map(k => k.mid as number))
  const added: KnowledgeEntry[] = []
  // 遍历**可见视图**（而非原始行）：被用户删除的消息从此不存在——不会进入上下文，也不会入账
  for (const m of store.effectiveMessages()) {
    if (!visibleTo(m, name)) continue
    if (known.has(m.id) || suppressed.has(m.id)) continue
    const entry: KnowledgeEntry = { source: '亲历', mid: m.id, round: m.round, text: witnessSummary(m, name) }
    memory.push(entry)
    added.push(entry)
  }
  return added
}

/**
 * 注入片段（§5.5）：最新条目优先，总预算 budgetChars；
 * 与"最近 recentCount 条可见消息"重叠的条目跳过——近期内容由消息窗口承担，不重复注入。
 * 条目文本即原文移植（库存原文，注入按预算截断）。
 */
export function buildMemory(
  store: StoryStore,
  name: string,
  memory: KnowledgeEntry[],
  opts: { recentCount?: number; budgetChars?: number } = {},
): string {
  const recentCount = opts.recentCount ?? config.contextWindow
  const budgetChars = opts.budgetChars ?? 6000
  const msgs = store.effectiveMessages()
  const visible = msgs.filter(m => visibleTo(m, name))
  const recentIds = new Set(visible.slice(-recentCount).map(m => m.id))

  const entries = [...memory]
    .filter(k => k.mid === undefined || !recentIds.has(k.mid))
    .sort((a, b) => b.round - a.round)

  const blocks: string[] = []
  let used = 0
  for (const k of entries) {
    if (used >= budgetChars) break
    const block = `- （第${k.round}轮得知，${k.source}）${k.text}`
    if (used + block.length > budgetChars && blocks.length > 0) break
    used += block.length
    blocks.push(block)
  }
  if (blocks.length === 0) return ''
  return `【你已知悉的事】\n${blocks.join('\n')}`
}

/**
 * 该角色**缺失的轮次**（额外记忆二段判定的候选集）：生效视图里有消息、但这些消息都不在他
 * 账本里的轮。升序返回最近 cap 轮，每轮附一句话摘要（首条消息前 40 字）供 Jev 判断转告范围。
 */
export function missingRounds(
  store: StoryStore,
  memory: KnowledgeEntry[],
  cap = 8,
): Array<{ round: number; summary: string }> {
  const known = new Set(memory.filter(k => k.mid !== undefined).map(k => k.mid as number))
  const byRound = new Map<number, MsgLine[]>()
  for (const m of store.effectiveMessages()) {
    if (known.has(m.id)) continue
    const bucket = byRound.get(m.round)
    if (bucket === undefined) byRound.set(m.round, [m])
    else bucket.push(m)
  }
  return [...byRound.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-cap)
    .map(([round, msgs]) => ({
      round,
      summary: `${msgs[0].name}：${msgs[0].text.slice(0, 40)}${msgs.length > 1 ? `（等${msgs.length}条）` : ''}`,
    }))
}

/**
 * 额外记忆移植（§5.7）：把命中轮里该角色还没有的消息**逐字**移植进账本，
 * source=额外得知（不是他的亲历感知，是被转告的），带原 mid/round（幂等、可撤回、活账本跟随）。
 * 按消息顺序追加在账本末尾。返回新增条目，调用方必须为其写 ledger 行。
 */
export function transplantRounds(
  store: StoryStore,
  name: string,
  memory: KnowledgeEntry[],
  rounds: ReadonlySet<number>,
): KnowledgeEntry[] {
  const known = new Set(memory.filter(k => k.mid !== undefined).map(k => k.mid as number))
  const added: KnowledgeEntry[] = []
  for (const m of store.effectiveMessages()) {
    if (!rounds.has(m.round) || known.has(m.id)) continue
    const entry: KnowledgeEntry = { source: '额外得知', mid: m.id, round: m.round, text: witnessSummary(m, name) }
    memory.push(entry)
    added.push(entry)
  }
  return added
}
