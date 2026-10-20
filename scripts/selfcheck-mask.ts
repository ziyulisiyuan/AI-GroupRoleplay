/**
 * 面具离线自检（SPEC §3.6a）：面具是**用户侧的替代人设**，不是角色。
 *
 * 钉住的四件事：
 * 1) 存储与校验：面具之间不重名、**不得与角色重名**、非法名拒绝、校验失败一字不写、
 *    正戴着的那副不能删、悬空编号按未戴处理；
 * 2) 引擎接线：戴着时用户消息的署名与逐字记忆 = 面具的称呼；摘下回到基础称呼；
 * 3) 快照：mask = 面具编号，userName 仍是基础称呼（基础资料页用）；面具不进角色名单；
 * 4) 历史不追溯：戴面具之前写下的消息，署名一个字都不改。
 *
 * 全程在工作区 groups/_acc-mask 内进行，finally 清理；settings.yaml 备份/还原（与其它自检同一套约定）。
 * 离线：settings.yaml 只指向回收地址 127.0.0.1:9 —— 模型调用必然立刻失败，不产生任何真实请求。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { GroupSession } from '../src/group/engine.ts'
import { currentMask, loadCurrentMaskId, loadMaskList, maskNameTaken, maskPath, saveMaskList, setCurrentMask } from '../src/group/mask.ts'
import { saveUserPersona } from '../src/group/scaffold.ts'
import { loadFiles } from '../src/group/status.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'

const accName = '_acc-mask'
const accDir = join(config.groupsDir, accName)
const settingsFile = join(config.root, 'settings.yaml')
const hadSettings = existsSync(settingsFile)
const backup = hadSettings ? readFileSync(settingsFile, 'utf8') : undefined
// 备份落盘：进程被硬崩溃打死时 finally 不会执行，磁盘上的孤儿备份供 server/cli 启动时自愈
writeFileSync(settingsFile + '.selfcheck-bak', backup ?? '', 'utf8')
// 中间判定规则（工作区根的真实用户数据）：自检期间必须为零，否则角色输出会走草稿链、判定调用次数对不上
const midFile = join(config.root, '中间判定.jsonl')
const hadMid = existsSync(midFile)
const midBackup = hadMid ? readFileSync(midFile, 'utf8') : undefined
if (hadMid) rmSync(midFile, { force: true })

const BASE_NAME = '（基础称呼）'
const MASK_NAME = '马甲'

/** 消费一整轮：模型调用必然失败（回收地址），只关心它已经落盘的部分。 */
async function drain(gen: AsyncIterable<unknown>): Promise<void> {
  try {
    for await (const ev of gen) void ev
  } catch { /* 预期：回收地址连不上 */ }
}

try {
  rmSync(accDir, { recursive: true, force: true })
  buildGroupFixture(accDir, { chars: TEST_CAST })
  saveUserPersona(accDir, { name: BASE_NAME, text: '（基础自述）' })
  writeFileSync(
    settingsFile,
    `activeId: pd\nrouterId: ''\nproviders:\n  - { id: pd, name: offline, baseUrl: 'http://127.0.0.1:9', apiKey: fake, model: fake-model, reasoningEffort: off }\n`,
    'utf8',
  )

  // ── 1) 存储与校验
  saveMaskList(accDir, [{ id: 'm1', name: MASK_NAME, text: '（面具自述）' }])
  assert.ok(existsSync(maskPath(accDir)), '面具.jsonl 必须落盘')
  assert.deepEqual(loadMaskList(accDir), [{ id: 'm1', name: MASK_NAME, text: '（面具自述）' }])
  const before = readFileSync(maskPath(accDir), 'utf8')
  assert.throws(() => saveMaskList(accDir, [{ id: 'm2', name: '角色甲', text: '' }]), /与角色重名/, '面具不得与角色重名')
  assert.throws(() => saveMaskList(accDir, [{ id: 'm1', name: '甲', text: '' }, { id: 'm2', name: '甲', text: '' }]), /面具之间不能重名/)
  assert.throws(() => saveMaskList(accDir, [{ id: 'm1', name: '甲', text: '' }, { id: 'm1', name: '乙', text: '' }]), /编号重复/)
  assert.throws(() => saveMaskList(accDir, [{ id: '', name: '甲', text: '' }]), /编号/)
  assert.throws(() => saveMaskList(accDir, [{ id: 'm3', name: 'a/b', text: '' }]), /非法面具名/)
  assert.equal(readFileSync(maskPath(accDir), 'utf8'), before, '任何一条不合格 → 一个字都不写')
  // 反方向的对称校验：角色创建/改名侧（server）用 maskNameTaken 拒绝与面具同名
  assert.equal(maskNameTaken(accDir, MASK_NAME), true, '面具名占用 → 角色不得叫这个名字')
  assert.equal(maskNameTaken(accDir, '角色丙'), false, '没被占用的名字照常可建角色')

  // ── 2) 戴 / 摘：戴着的那副不能删、不存在的编号不能戴
  assert.equal(currentMask(accDir), null, '默认没戴面具')
  setCurrentMask(accDir, 'm1')
  assert.deepEqual(currentMask(accDir), { id: 'm1', name: MASK_NAME, text: '（面具自述）' })
  assert.throws(() => saveMaskList(accDir, []), /先摘下再删除/, '正戴着的面具不能从列表里删掉')
  assert.throws(() => setCurrentMask(accDir, '不存在'), /面具不存在/)

  // ── 3) 引擎接线：署名与逐字记忆 = 面具；面具不是角色
  const s = GroupSession.open(accName)
  const snapMasked = s.snapshot()
  assert.equal(snapMasked.mask, 'm1', '快照要带当前面具编号')
  assert.equal(snapMasked.userName, BASE_NAME, '快照的 userName 仍是基础称呼（基础资料页用）')
  assert.ok(!snapMasked.characters.some(c => c.name === MASK_NAME), '面具不是角色：不得出现在角色名单里')
  assert.ok(!s.characterNames().includes(MASK_NAME), '面具不参与路由候选')

  await drain(s.speak('（测试发言·戴面具）'))
  const maskedUsers = s.store.messages.filter(m => m.role === 'user')
  const firstUser = maskedUsers.at(-1)
  assert.equal(firstUser?.name, MASK_NAME, '戴面具时用户消息的署名 = 面具的称呼')
  // 受众顺序取决于角色目录的读取顺序（文件系统顺序，不作契约）——按集合比
  const audience = Array.isArray(firstUser?.visible_to) ? [...firstUser.visible_to].sort() : firstUser?.visible_to
  assert.deepEqual(audience, TEST_CAST.map(c => c.name).sort(), '知情名单照常（面具不影响受众）')
  const maskedEntry = loadFiles(join(accDir, '角色', '角色甲')).memory.at(-1)
  assert.equal(maskedEntry?.text, `${MASK_NAME}：（测试发言·戴面具）`, '记忆是逐字原文移植，署名 = 面具的称呼')
  assert.equal(maskedEntry?.source, '亲历')
  assert.equal(maskedEntry?.mid, firstUser?.id)

  // ── 4) 摘下：回到基础资料；历史不追溯
  setCurrentMask(accDir, '')
  assert.equal(currentMask(accDir), null)
  assert.equal(GroupSession.open(accName).snapshot().mask, '', '摘下后快照无面具')
  await drain(s.speak('（测试发言·无面具）'))
  const allUsers = s.store.messages.filter(m => m.role === 'user')
  assert.equal(allUsers.at(-1)?.name, BASE_NAME, '摘下面具后署名回到基础称呼')
  assert.equal(
    loadFiles(join(accDir, '角色', '角色甲')).memory.at(-1)?.text,
    `${BASE_NAME}：（测试发言·无面具）`,
    '摘下后新记忆按基础称呼移植',
  )
  assert.equal(allUsers[0]?.name, MASK_NAME, '戴面具之前/期间写下的消息不追溯改名')

  // ── 5) 悬空编号（文件被手工改坏）按未戴处理，不炸
  setCurrentMask(accDir, 'm1')
  writeFileSync(maskPath(accDir), '', 'utf8')
  assert.equal(loadCurrentMaskId(accDir), 'm1')
  assert.equal(currentMask(accDir), null, '编号指向已不存在的面具 → 视为未戴')
  assert.equal(GroupSession.open(accName).snapshot().mask, '')

  console.log('面具自检通过：存储与唯一性（面具内唯一 / 不得与角色重名 / 校验失败一字不写 / 戴着不能删 / 悬空按未戴） · 署名与逐字记忆 = 面具 · 摘下回基础资料 · 历史不追溯 · 面具不进角色名单与路由')
} finally {
  rmSync(accDir, { recursive: true, force: true })
  if (hadSettings) writeFileSync(settingsFile, backup ?? '', 'utf8')
  else if (existsSync(settingsFile)) rmSync(settingsFile, { force: true })
  rmSync(settingsFile + '.selfcheck-bak', { force: true })
  if (hadMid) writeFileSync(midFile, midBackup ?? '', 'utf8')
  else if (existsSync(midFile)) rmSync(midFile, { force: true })
}
