/**
 * 编辑器（M5）离线自检：脚手架产物必须能被真正的加载器与组装器吃下。
 * 全程在工作区 groups/_acc-scaffold 内进行，finally 清理。
 */
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { GroupSession } from '../src/group/engine.ts'
import { loadCharacters, loadGroupSettings, loadUserPersona } from '../src/group/persona.ts'
import { loadFiles, savePersonality } from '../src/group/status.ts'
import { createCharacter, createGroup, isValidName, readCharacterDraft, saveUserPersona, updateCharacter } from '../src/group/scaffold.ts'
import { assembleGroup } from '../src/group/host.ts'
import type { MsgLine } from '../src/store.ts'

const groupDir = join(config.groupsDir, '_acc-scaffold')
const cleanup = (): void => rmSync(groupDir, { recursive: true, force: true })

try {
  cleanup()
  // 建群
  createGroup(groupDir, { era: '（时代）', world: '（世界观）', tone: '（基调）' })
  assert.ok(existsSync(join(groupDir, '群设定.yaml')), '群设定必须是 .yaml（纯字段文件）')
  const gs = loadGroupSettings(groupDir)
  assert.deepEqual(gs, { era: '（时代）', world: '（世界观）', tone: '（基调）' })
  assert.throws(() => createGroup(groupDir, { era: '', world: '', tone: '' }), /已存在/)

  // 零角色是合法状态：新建的群必须能被引擎打开（否则前端点进去就白屏）
  const empty = GroupSession.open('_acc-scaffold')
  assert.deepEqual(empty.snapshot().characters, [], '空群的快照应返回零角色')
  assert.deepEqual(empty.statusLines(), [], '空群的状态摘要应为空数组')
  assert.equal(empty.snapshot().userName, '你', '未设定时用户称呼默认"你"')

  // 用户设定（单文件、自由格式）：角色必须能看到
  saveUserPersona(groupDir, { name: '（测试称呼）', text: '（测试用户自述）' })
  assert.ok(existsSync(join(groupDir, '用户.md')), '用户设定必须是单文件 用户.md')
  const loadedMe = loadUserPersona(groupDir)
  assert.deepEqual(loadedMe, { name: '（测试称呼）', text: '（测试用户自述）' })
  assert.equal(GroupSession.open('_acc-scaffold').snapshot().userName, '（测试称呼）', '引擎读到的用户称呼')
  saveUserPersona(groupDir, { name: '', text: '（只有正文）' })
  assert.equal(loadUserPersona(groupDir).name, '你', '空称呼回退为"你"')

  // 建角色
  createCharacter(groupDir, {
    name: '角色甲',
    appearance: '（外观）',
    background: '（背景）',
    personality: '（初始性格）',
    relationships: '（初始关系）',
  })
  for (const f of ['角色.md', '性格.md', '人物关系.md', '状态.yaml', '记忆.jsonl']) {
    assert.ok(existsSync(join(groupDir, '角色', '角色甲', f)), `缺少 ${f}`)
  }
  assert.throws(() => createCharacter(groupDir, { name: '角色甲', appearance: '', background: '', personality: '', relationships: '' }), /已存在/)

  const chars = loadCharacters(groupDir)
  assert.equal(chars.length, 1)
  assert.equal(chars[0].name, '角色甲')

  const files = loadFiles(join(groupDir, '角色', '角色甲'))
  assert.equal(files.personality.base, '（初始性格）')
  assert.equal(files.relationships.base, '（初始关系）')

  // 组装：编辑器写的内容必须真的进 prompt（含用户设定）
  const history: MsgLine[] = [{ type: 'msg', id: 1, role: 'user', name: '你', text: '（发言）', round: 1, visible_to: 'all', ts: 'x' }]
  const { system } = assembleGroup(chars[0], gs, history, {
    files,
    userPersona: { name: '（测试称呼）', text: '（测试用户自述）' },
    rules: '（测试规则：必须包含这一句）',
  })
  for (const piece of ['（外观）', '（背景）', '（初始性格）', '（初始关系）', '（时代）', '（世界观）', '【和你对话的人】', '（测试称呼）', '（测试用户自述）', '【规则（用户设定）】', '（测试规则：必须包含这一句）']) {
    assert.ok(system.includes(piece), `prompt 缺少 ${piece}`)
  }
  assert.ok(!system.includes('（基调）'), '基调只给总管，不得下发角色')
  // 规则为空时不得出现空标题
  assert.ok(!assembleGroup(chars[0], gs, history, { files, rules: '   ' }).system.includes('【规则（用户设定）】'), '空规则不得注入标题')

  // 回填草稿
  const draft = readCharacterDraft(groupDir, '角色甲')
  assert.equal(draft.personality, '（初始性格）')
  assert.equal(draft.background, '（背景）')

  // 更新：只改用户初始设定；动态部分在状态账本，编辑器/总管都不碰性格.md 的初始内容
  const dir = join(groupDir, '角色', '角色甲')
  updateCharacter(groupDir, '角色甲', { ...draft, personality: '（改后的性格）', relationships: '（改后的关系）' })
  const after = loadFiles(dir)
  assert.equal(after.personality.base, '（改后的性格）')
  assert.equal(after.relationships.base, '（改后的关系）')

  // 名字校验
  assert.ok(isValidName('正常名字'))
  for (const bad of ['', '   ', 'a/b', 'a\\b', '..', 'x:y']) assert.ok(!isValidName(bad), `应拒绝: ${JSON.stringify(bad)}`)

  console.log('M5 离线自检通过：建群/建角色/五文件落盘/回填/名字校验')
} finally {
  cleanup()
}
