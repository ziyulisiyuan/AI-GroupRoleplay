/**
 * 记忆（知情账本）运行时（SPEC §4.3/§5）：
 * - backfillKnowledge：凡 `visible_to` 可见（= Jev 判定的知情名单）且账本尚无该 mid 的消息，
 *   把**原文原样**移植进该角色的账本（不做任何总结改写——总结是虚构的唯一入口）。
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
 * 客观注入的消息（objective 标记）移植来源为「客观」——它不是被感知的事件，
 * 是用户显式声明、已对世界生效的客观事实，同样逐字移植、带 mid。
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
    const entry: KnowledgeEntry = { source: m.objective === true ? '客观' : '亲历', mid: m.id, round: m.round, text: witnessSummary(m, name) }
    memory.push(entry)
    added.push(entry)
  }
  return added
}

/**
 * 注入片段（§5.5）：最新条目优先，总预算 budgetChars；
 * 与"最近 recentCount 条可见消息"重叠的条目跳过——近期内容由消息窗口承担，不重复注入。
 * 条目文本即原文移植（库存原文，注入按预算截断）。
 * 「额外得知」条目在注入时按转告人加一句框架（"X 把下面这些事告诉了你——你当时不在场……"）——
 * 只加在提示词里，台账原文不动；没有 teller 的老条目退回旧标签。
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

  const lines: string[] = []
  let used = 0
  /** 当前所处的「额外得知」连续段由谁转告（undefined = 不在段内，或该段没有转告人）。 */
  let framedTeller: string | undefined
  const push = (line: string): boolean => {
    if (used + line.length + 1 > budgetChars && lines.length > 0) return false
    used += line.length + 1
    lines.push(line)
    return true
  }
  for (const k of entries) {
    // 额外得知：同一转告人的连续段前加一句框架——"X告诉了你"。这句只在提示词里，台账原文不动。
    if (k.source === '额外得知' && k.teller !== undefined) {
      if (k.teller !== framedTeller) {
        framedTeller = k.teller
        if (!push(`${k.teller}把下面这些事告诉了你——你当时不在场，是听${k.teller}说的。这些内容你已经知道，可以直接提起：`)) break
      }
      if (!push(`- （第${k.round}轮得知）${k.text}`)) break
      continue
    }
    framedTeller = undefined
    if (!push(`- （第${k.round}轮得知，${k.source}）${k.text}`)) break
  }
  if (lines.length === 0) return ''
  return `【你已知悉的事】\n${lines.join('\n')}`
}

/**
 * 该角色**缺失的轮次**（额外记忆二段判定的候选集）：生效视图里有消息、但这些消息都不在他
 * 账本里的轮。升序返回全部缺失轮，每轮附**整轮原文**（该轮全部消息逐字，不截断不摘要）
 * 供 Jev 判断转告范围——Jev 没有输入上限，给全才判得准。
 */
export function missingRounds(
  store: StoryStore,
  memory: KnowledgeEntry[],
): Array<{ round: number; text: string }> {
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
    .map(([round, msgs]) => ({
      round,
      text: msgs.map(m => `${m.name}：${m.text}`).join('\n'), // 整轮原文：与 transplantRounds 移植的文本逐字一致
    }))
}

/**
 * 额外记忆移植（§5.7）：把命中轮里该角色还没有的消息**逐字**移植进账本，
 * source=额外得知（不是他的亲历感知，是被转告的），带原 mid/round（幂等、可撤回、活账本跟随）。
 * 按消息顺序追加在账本末尾。返回新增条目，调用方必须为其写 ledger 行。
 * teller = 谁把这段事转告给他的（注入时据此加一句"X告诉了你"的框架；用户发言触发=用户称呼，
 * 角色回复触发=当时说话的角色名）。缺省（老数据/无来源）不加框架。
 */
export function transplantRounds(
  store: StoryStore,
  name: string,
  memory: KnowledgeEntry[],
  rounds: ReadonlySet<number>,
  teller?: string,
): KnowledgeEntry[] {
  const known = new Set(memory.filter(k => k.mid !== undefined).map(k => k.mid as number))
  const added: KnowledgeEntry[] = []
  for (const m of store.effectiveMessages()) {
    if (!rounds.has(m.round) || known.has(m.id)) continue
    const entry: KnowledgeEntry = {
      source: '额外得知',
      mid: m.id,
      round: m.round,
      text: witnessSummary(m, name),
      ...(teller === undefined || teller === '' ? {} : { teller }),
    }
    memory.push(entry)
    added.push(entry)
  }
  return added
}
