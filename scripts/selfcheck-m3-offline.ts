/**
 * M3 离线自检（SPEC §6 M3，无需 API key，全临时目录）：
 * 1) 可见性过滤：私聊消息不进入其他角色的组装输入，但进入目标角色的输入。
 * 2) 公开事件自动登记：backfill 幂等（重复调用不新增）；新消息产生增量。
 * 3) 注入算法：条目即原文移植（不摘编）；预算截断。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { StoryStore } from '../src/store.ts'
import { assembleGroup } from '../src/group/host.ts'
import { backfillKnowledge, buildMemory } from '../src/group/knowledge.ts'
import type { KnowledgeEntry } from '../src/group/status.ts'
import type { CharacterPersona, GroupSettings } from '../src/group/persona.ts'

const dir = mkdtempSync(join(tmpdir(), 'm3-selfcheck-'))
try {
  const store = StoryStore.open(join(dir, 'g'), 'g')
  const settings: GroupSettings = { era: '', world: '', tone: '' }
  const persona: CharacterPersona = { dirName: '角色甲', name: '角色甲', appearance: '', body: '', personalityFallback: '', relationshipsFallback: '' }
  const SECRET = '（测试机密）'

  store.append('user', '你', '（公开发言一）')
  store.append('character', '角色乙', '（公开发言二）')
  store.append('character', '角色甲', '（本人公开发言）')
  store.append('user', '你', '（公开发言三）')
  store.append('user', '你', `（私下）${SECRET}`, ['角色乙']) // 对角色甲不可见

  // 1) 可见性过滤
  const all = store.effectiveMessages()
  const visible = assembleGroup(persona, settings, all)
  assert.ok(!visible.messages.some(m => m.content.includes(SECRET)), "角色甲的输入不得包含私聊内容（'物理看不到'）")
  const other: CharacterPersona = { ...persona, dirName: '角色乙', name: '角色乙' }
  assert.ok(assembleGroup(other, settings, all).messages.some(m => m.content.includes(SECRET)), '角色乙的输入必须包含私聊内容')

  // 2) 公开事件自动登记（幂等）
  const memory: KnowledgeEntry[] = []
  assert.ok(backfillKnowledge(store, '角色甲', memory).length > 0, '首次回填应有新增')
  const n1 = memory.length
  assert.equal(backfillKnowledge(store, '角色甲', memory).length, 0, '重复回填必须幂等')
  assert.equal(memory.length, n1)
  assert.ok(!memory.some(k => k.text.includes(SECRET)), '私聊内容不得登记给不在场者')
  store.append('character', '角色乙', '（公开发言四）')
  assert.ok(backfillKnowledge(store, '角色甲', memory).length > 0, '新消息应产生增量登记')

  // 3) 注入算法：条目即原文（不摘编）+ 预算截断
  const big: KnowledgeEntry[] = [...memory]
  big.push({ source: '亲历', mid: 2, round: 1, text: '（占位条目）' })
  big.push({ source: '推断', round: 2, text: '（推断条目）' })
  const mem = buildMemory(store, '角色甲', big, { recentCount: 3, budgetChars: 2000 })
  assert.ok(mem.includes('你已知悉的事'), '注入块标题')
  assert.ok(mem.includes('（推断条目）'), '无 mid 条目直接注入')
  assert.ok(mem.includes('（公开发言二）'), '条目即原文移植')
  // 原文移植：亲历条目必须是逐字原文（含说话人标识），不是摘要/改写
  assert.ok(memory.some(k => k.mid === 1 && k.text === '你：（公开发言一）'), `亲历条目必须逐字原文，实得：${JSON.stringify(memory.find(k => k.mid === 1)?.text)}`)
  const tiny = buildMemory(store, '角色甲', big, { recentCount: 3, budgetChars: 100 })
  assert.ok(tiny.length < 400, `超小预算应大幅截断，实得 ${tiny.length} 字符`)

  // 4) 消息窗口：assembleGroup 只注入最近 CONTEXT_WINDOW 条可见消息（§6.2，默认 36），更早的由记忆承担
  const store2 = StoryStore.open(join(dir, 'w'), 'w')
  for (let i = 1; i <= 50; i++) store2.append('user', '你', `第${i}句话`)
  const win = assembleGroup(persona, settings, store2.effectiveMessages(), {})
  const flat = JSON.stringify(win.messages)
  assert.ok(!flat.includes('第14句'), '窗口外的旧消息不得注入')
  assert.ok(flat.includes('第15句') && flat.includes('第50句'), `最近 ${config.contextWindow} 条必须注入`)
  assert.ok(win.system.includes('你扮演「角色甲」'), '组装必须产出 system（生产路径要作为首条消息发送）')

  console.log('M3 离线自检通过：可见性过滤 / 自动登记幂等（原文移植） / 注入预算截断 / 消息窗口=CONTEXT_WINDOW')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
