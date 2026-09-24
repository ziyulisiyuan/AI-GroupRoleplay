/**
 * rebuild（SPEC §4.5 / §6 M2）：pnpm rebuild <群聊名>
 * 从 剧情.jsonl 重放 ledger 行，重建每个角色的 状态.yaml / 性格.md / 人物关系.md / 记忆.jsonl。
 * 角色.md 是用户专属文件，rebuild 永不触碰。
 *
 * 一次性修复：旧格式迁移上来的条目在 jsonl 中可能没有 ledger 行，
 * 把这些"磁盘上有、日志里没有"的条目补写成 ledger 行，使 jsonl 真正成为唯一事实源。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { StoryStore } from '../src/store.ts'
import { loadCharacters } from '../src/group/persona.ts'
import { emptyFiles, saveMemory, savePersonality, saveRelationships, saveStatus, applyLedgerEvent, loadFiles, mergeRebuiltFiles, type KnowledgeEntry } from '../src/group/status.ts'
import { saveScene } from '../src/group/presence.ts'

const groupName = process.argv[2]
if (groupName === undefined || groupName === '') {
  console.error('用法: pnpm rebuild <群聊名>')
  process.exit(1)
}
const groupDir = join(config.groupsDir, groupName)
if (!existsSync(groupDir)) {
  console.error(`群聊目录不存在: ${groupDir}`)
  process.exit(1)
}
const store = StoryStore.open(groupDir, groupName)
const characters = loadCharacters(groupDir)

for (const persona of characters) {
  const charDir = join(groupDir, '角色', persona.dirName)
  const onDisk = loadFiles(charDir) // 含旧格式自动迁移
  const derived = emptyFiles()
  for (const line of store.allLines) {
    // 名字链归一：角色改名前的旧账目（ledger 行记旧名）经 rename 行归到当前名下重放，不丢历史
    if (line.type !== 'ledger' || store.nameOf(line.character) !== persona.name) continue
    applyLedgerEvent(derived, line.op, line.section, line.content, 0)
  }

  // 状态账本：本角色日志里一条新式快照行都没有时，保留磁盘上（播种后）的账本，避免丢历史
  const hasSnapshot = store.allLines.some(l => l.type === 'ledger' && store.nameOf(l.character) === persona.name && l.section === 'status' && l.content.startsWith('{'))
  if (!hasSnapshot) derived.status = onDisk.status

  // 补齐：磁盘上有而重放结果里没有的记忆条目 → 写 ledger 行并纳入
  let repaired = 0
  for (const e of onDisk.memory) {
    const dup = derived.memory.some(x => (x.mid !== undefined && x.mid === e.mid) || x.text === e.text)
    if (dup) continue
    const payload: KnowledgeEntry = { source: e.source, ...(e.mid === undefined ? {} : { mid: e.mid }), round: e.round, text: e.text }
    store.appendLedgerLine(persona.name, 'knowledge', 'append', JSON.stringify(payload))
    applyLedgerEvent(derived, 'append', 'knowledge', JSON.stringify(payload), e.round)
    repaired++
  }

  // 用户资产（性格原文/关系备注）受保护；状态账本以重放为准（无快照行时为播种后的磁盘值）
  const files = mergeRebuiltFiles(onDisk, derived)
  saveStatus(charDir, files.status)
  savePersonality(charDir, files.personality)
  saveRelationships(charDir, files.relationships)
  saveMemory(charDir, files.memory)
  const filled = (['生理状态', '心理状态', '外观状态', '位置状态', '性格演变', '姓名变化', '人物关系变化'] as const).filter(k => (files.status[k] ?? '').trim() !== '').length
  console.log(`rebuild ${persona.name}: 状态账本 ${filled}/7 字段有值 · 记忆 ${files.memory.length} 条`
    + (repaired > 0 ? `（补写 ledger ${repaired} 条）` : ''))
}

// 在场.yaml 同样是从日志重放的派生缓存（presence 行里的旧名经名字链归一）
const lastScene = store.lastScene()
if (lastScene !== undefined) {
  const names = new Set(characters.map(c => c.name))
  const fix = (links: typeof lastScene.remote): typeof lastScene.remote =>
    links.map(l => ({ ...l, character: store.nameOf(l.character) })).filter(l => names.has(l.character))
  const scene = { present: lastScene.present.map(n => store.nameOf(n)).filter(n => names.has(n)), remote: fix(lastScene.remote), overhear: fix(lastScene.overhear) }
  saveScene(groupDir, scene)
  const remote = scene.remote.map(l => `${l.character}（${l.note ?? '远程'}）`).join('、')
  const overhear = scene.overhear.map(l => `${l.character}（${l.note ?? '单向感知'}）`).join('、')
  console.log(`rebuild 场景: 现场 ${scene.present.length > 0 ? scene.present.join('、') : '（无）'}`
    + (remote !== '' ? `｜接入 ${remote}` : '')
    + (overhear !== '' ? `｜感知 ${overhear}` : ''))
}
