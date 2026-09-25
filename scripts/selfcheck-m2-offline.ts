/**
 * M2 离线自检（SPEC §3.4a 状态账本模型，无需 API key，全临时目录）：
 * 1) 状态账本固定七字段：确定性序列化 + 幂等（rebuild 幂等依赖）。
 * 2) 整体快照语义：快照行逐字段覆盖，无叠加污染。
 * 3) 记忆撤回：按 mid 与按文本（回填不复活）。
 * 4) prompt 片段：账本固定格式；性格/关系 = 用户初始。
 * 5) 角色.md 与 性格.md/人物关系.md 的用户部分永不被 AI 写路径改动。
 * 6) 消息改删（当前上下文快照语义：物理改写/移除，id 不复用）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LEDGER_KEYS, loadFiles, saveStatus, saveMemory, savePersonality, saveRelationships, applyLedgerEvent,
  mergeRebuiltFiles, emptyFiles, ledgerPrompt, personalityPrompt, relationshipsPrompt, type CharacterFiles,
} from '../src/group/status.ts'
import { StoryStore } from '../src/store.ts'

const dir = mkdtempSync(join(tmpdir(), 'm2-selfcheck-'))
const ROLE_MD = '---\nname: 角色甲\nappearance: |\n  （测试外观）\n---\n\n（测试背景）\n'
const FILES = ['状态.yaml', '性格.md', '人物关系.md', '记忆.jsonl']

try {
  // 事件序列：两次快照（整体覆盖）+ 记忆增删
  const snapshots = [
    { 生理状态: '（值一）', 心理状态: '（平静）', 外观状态: '', 位置状态: '牢房内', 性格演变: '', 姓名变化: '无', 人物关系变化: '对角色乙：戒备' },
    { 生理状态: '（值一改）', 心理状态: '（屈辱）', 外观状态: '衣衫凌乱', 位置状态: '牢房内墙角', 性格演变: '更加警惕', 姓名变化: '无', 人物关系变化: '对角色乙：戒备加深' },
  ]
  const applySnapshot = (f: CharacterFiles, snap: Record<string, string>): void =>
    applyLedgerEvent(f, 'set', 'status', JSON.stringify(snap), 0)

  const filesA: CharacterFiles = emptyFiles()
  applySnapshot(filesA, snapshots[0])
  applySnapshot(filesA, snapshots[1])
  applyLedgerEvent(filesA, 'append', 'knowledge', JSON.stringify({ source: '亲历', mid: 42, round: 4, text: '（将被按 mid 撤回）' }), 4)
  applyLedgerEvent(filesA, 'append', 'knowledge', JSON.stringify({ source: '推断', round: 3, text: '（测试条目二）' }), 3)
  applyLedgerEvent(filesA, 'retract', 'knowledge', JSON.stringify({ mid: 42 }), 5)

  writeFileSync(join(dir, '角色.md'), ROLE_MD, 'utf8')

  const dirA = join(dir, 'A', '角色甲')
  saveStatus(dirA, filesA.status)
  savePersonality(dirA, filesA.personality)
  saveRelationships(dirA, filesA.relationships)
  saveMemory(dirA, filesA.memory)

  // 1) 幂等：load → save 逐字节不变
  const before = FILES.map(n => readFileSync(join(dirA, n), 'utf8'))
  const again = loadFiles(dirA)
  saveStatus(dirA, again.status)
  savePersonality(dirA, again.personality)
  saveRelationships(dirA, again.relationships)
  saveMemory(dirA, again.memory)
  FILES.forEach((n, i) => assert.equal(readFileSync(join(dirA, n), 'utf8'), before[i], `${n} 幂等`))

  // 2) 快照语义：状态.yaml 只含最新版（旧"（值一）"不再出现——无叠加污染）
  for (const k of LEDGER_KEYS) assert.ok(k in again.status, `固定字段 ${k} 必须在账本里`)
  assert.equal(again.status['生理状态'], '（值一改）', '整体快照 = 最新版')
  assert.ok(!JSON.stringify(again.status).includes('（平静）'), '旧版本字段不得残留（防上下文污染）')
  assert.equal(again.status['姓名变化'], '无')
  assert.equal(again.memory.length, 1, '撤回后应只剩 1 条记忆')
  assert.ok(!again.memory.some(e => e.mid === 42), '按 mid 撤回必须生效')

  // 3) prompt 片段：账本固定格式 + 初始性格/关系不含动态
  assert.ok(ledgerPrompt(again.status).includes('生理状态:"（值一改）"'), '账本 prompt 用固定格式')
  assert.ok(ledgerPrompt(again.status).includes('姓名变化:"无"'), '空/无值字段显示"无"')
  assert.equal(personalityPrompt(again.personality), again.personality.base, '性格 prompt = 用户初始')
  assert.equal(relationshipsPrompt(again.relationships), again.relationships.base, '关系 prompt = 用户初始')

  // 4) 账本规范化：非七字段的未知键在 loadFiles 时被丢弃
  const unknownDir = join(dir, 'unknown', '角色乙')
  mkdirSync(unknownDir, { recursive: true })
  writeFileSync(join(unknownDir, '状态.yaml'), '生理状态: 左臂受伤\n未知字段: 值\n', 'utf8')
  const normalized = loadFiles(unknownDir)
  assert.deepEqual(Object.keys(normalized.status), ['生理状态'], '账本只保留固定七字段')

  // 5) 角色.md 永不被写 + 消息改删（当前上下文快照语义：物理改写/移除）
  assert.equal(readFileSync(join(dir, '角色.md'), 'utf8'), ROLE_MD, '角色.md 不得被任何写路径改动')
  const raw = (): string => readFileSync(join(dir, 'g2', '剧情.jsonl'), 'utf8')
  const s2 = StoryStore.open(join(dir, 'g2'), 'g2')
  s2.append('user', '你', '（原文）')
  s2.append('character', '角色甲', '（回复甲）')
  s2.rewriteMessage(2, '（改后回复）')
  assert.ok(raw().includes('（改后回复）'), '手改 = 日志行就地更新')
  assert.ok(!raw().includes('（回复甲）'), '手改后原文不得残留在日志里')
  s2.rewriteMessage(2, '（最终版）')
  assert.ok(!raw().includes('（改后回复）'), '再次改写同样不留旧文')
  s2.removeMessage(1)
  assert.ok(!raw().includes('（原文）'), '手删 = 消息行从日志移除（原文不留痕）')
  assert.ok(!s2.effectiveMessages().some(m => m.id === 1))
  assert.equal(s2.append('user', '你', '（新消息）').id, 3, '物理删除后的 id 不得复用（header.lastMsgId 保证单调）')

  // 6) mergeRebuiltFiles：性格/关系只保留用户初始，账本以重放为准
  const merged = mergeRebuiltFiles(again, filesA)
  assert.equal(merged.personality.base, again.personality.base, '用户初始性格保留')
  assert.equal(merged.relationships.base, again.relationships.base, '用户初始关系保留')
  assert.equal(merged.status, filesA.status, '状态账本以重放为准')

  console.log('M2 离线自检通过：账本固定七字段/整体快照幂等 · 记忆撤回 · 角色.md与初始文件只读 · 消息物理改删')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
