/**
 * M1 离线自检（SPEC §6 M1，无需 API key，全临时目录）：
 * 1) 角色只读文件/群设定加载（含 BOM 容错、值内冒号、默认值回填）。
 * 2) 路由启发式：提及命中（别名/最长匹配）、掷骰禁连说、零权重、退化、空群。
 * 3) 名字归一（别名/短名/空格/名单外）。
 * 4) 群聊组装：五文件注入（只读角色.md/性格+演变/人物关系/状态）、前缀、角色映射、连续合并。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCharacter, loadCharacters, loadGroupSettings, type CharacterPersona } from '../src/group/persona.ts'
import { loadFiles } from '../src/group/status.ts'
import { detectMention, dicePick, heuristicPick, resolveCharacterName, type RoutableCharacter } from '../src/group/router.ts'
import { assembleGroup } from '../src/group/host.ts'
import type { MsgLine } from '../src/store.ts'

const dir = mkdtempSync(join(tmpdir(), 'm1-selfcheck-'))
try {
  // 1) 只读文件加载
  const groupDir = join(dir, '群A')
  mkdirSync(join(groupDir, '角色', '角色甲'), { recursive: true })
  mkdirSync(join(groupDir, '角色', '角色乙'), { recursive: true })
  writeFileSync(join(groupDir, '角色', '角色甲', '角色.md'), `---
name: 角色甲
appearance: |
  （测试外观：冒号：也该活得下去）
personality: （旧格式性格）
---

（测试背景）`)
  writeFileSync(join(groupDir, '角色', '角色乙', '角色.md'), `\uFEFF---
name: 角色乙
---

（测试背景）`)
  writeFileSync(join(groupDir, '群设定.md'), `---
era: （测试时代）
world: |
  （测试世界观）
tone:
---

（基调可空）`)

  const chars = loadCharacters(groupDir)
  assert.equal(chars.length, 2)
  const jia = chars.find(c => c.name === '角色甲')!
  assert.ok(jia.appearance.includes('冒号：也该活得下去'), '值里的冒号必须存活（js-yaml 意义所在）')
  assert.ok(jia.body.includes('测试背景'))
  assert.equal(jia.personalityFallback, '（旧格式性格）', '旧格式字段仍可读（由引擎种入 性格.md）')

  const gs = loadGroupSettings(groupDir)
  assert.equal(gs.era, '（测试时代）')
  assert.ok(gs.world.includes('测试世界观'))
  assert.equal(gs.tone, '')

  const single = loadCharacter(join(groupDir, '角色', '角色乙', '角色.md'))
  assert.equal(single.name, '角色乙')
  assert.equal(single.personalityFallback, '', '无 personality 字段时为空')

  // 2) 路由启发式（降级路径：按名字提及，其次等概率）
  const rc: RoutableCharacter[] = chars.map(c => ({ name: c.name }))
  assert.equal(detectMention(rc, '角色甲在吗'), '角色甲')
  assert.equal(detectMention(rc, '角色乙帮个忙'), '角色乙')
  assert.equal(detectMention(rc, '今天天气不错'), undefined, '无提及')

  const rc3: RoutableCharacter[] = [...rc, { name: '角色丙' }]
  const counts = new Map<string, number>()
  for (let i = 0; i < 600; i++) {
    const picked = dicePick(rc3, '角色甲')!
    assert.notEqual(picked, '角色甲', '禁连说')
    counts.set(picked, (counts.get(picked) ?? 0) + 1)
  }
  assert.equal(counts.size, 2, '除上家外都应有机会')
  for (const n of counts.values()) assert.ok(n > 100, `等概率抽查分布异常: ${JSON.stringify([...counts])}`)
  assert.equal(dicePick(rc, '角色乙'), '角色甲', '只剩一个候选时选它')
  assert.equal(heuristicPick([], 'x', undefined), undefined)
  assert.equal(heuristicPick(rc3, '角色丙请回话', '角色乙'), '角色丙', '提及优先于抽取')

  // 3) 名字归一（总管可能给短名/带空格）
  assert.equal(resolveCharacterName(rc, '角色甲'), '角色甲', '全名直通')
  assert.equal(resolveCharacterName(rc, '  角色乙 '), '角色乙', '首尾空格')
  assert.equal(resolveCharacterName(rc, '甲'), '角色甲', '短名按包含关系归一')
  assert.equal(resolveCharacterName(rc, '路人'), undefined, '名单外必须判空')

  // 4) 群聊组装（五文件注入）
  const settings = loadGroupSettings(groupDir)
  writeFileSync(join(groupDir, '角色', '角色甲', '性格.md'), '# 性格\n\n（测试性格）\n\n## 性格演变\n- (第3轮) （测试性格变化）\n')
  writeFileSync(join(groupDir, '角色', '角色甲', '人物关系.md'), '# 人物关系\n\n- 角色乙：（测试关系）\n')
  writeFileSync(join(groupDir, '角色', '角色甲', '状态.yaml'), '（测试字段）: （测试值）\n')
  const files = loadFiles(join(groupDir, '角色', '角色甲'))
  const { system, messages } = assembleGroup(jia, settings, charsHist(), { files })
  assert.ok(system.includes('（测试时代）'), 'era 注入')
  assert.ok(system.includes('测试世界观'), 'world 注入')
  assert.ok(system.includes('[以角色甲的身份'), '末尾指令')
  assert.ok(system.includes('（测试性格）'), '性格.md 注入')
  assert.ok(system.includes('（测试性格变化）'), '性格演变注入')
  assert.ok(system.includes('角色乙：（测试关系）'), '人物关系.md 注入')
  assert.ok(system.includes('（测试字段）：（测试值）'), '状态.yaml 注入')
  assert.ok(system.includes('冒号：也该活得下去'), '角色.md（用户专属）注入')
  assert.ok(messages.some(m => m.role === 'user' && m.content.includes('角色乙：他人发言1')), '他人发言带名字前缀')
  const own = messages.find(m => m.role === 'assistant')
  assert.ok(own !== undefined && own.content.includes('本人发言'), '自己发言映射为 assistant 且无前缀')
  const firstUser = messages.find(m => m.role === 'user')!
  assert.ok(firstUser.content.includes('你：来了\n角色乙：他人发言1\n角色乙：他人发言2'), '连续 user 侧发言合并为一消息')

  function charsHist(): MsgLine[] {
    const mk = (id: number, role: MsgLine['role'], name: string, text: string): MsgLine =>
      ({ type: 'msg', id, role, name, text, round: 1, visible_to: 'all', ts: '2025-01-01T00:00:00Z' })
    return [
      mk(1, 'user', '你', '来了'),
      mk(2, 'character', '角色乙', '他人发言1'),
      mk(3, 'character', '角色乙', '他人发言2'),
      mk(4, 'character', '角色甲', '本人发言'),
    ]
  }

  console.log('M1 离线自检通过：五文件加载/注入 · 路由启发式 · 名字归一 · 群聊组装')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
