/**
 * 场景接入 + 感知 自检（SPEC §3.11，无需 API key，全临时目录）：
 * 1) 在场.yaml 往返：现场 + 远程接入（电话/传音）两层。
 * 2) 感知字段解析：失聪/失明/两者，缺失=正常。
 * 3) 可见性快照语义：只有"场景内 ∩ 能感知"的角色会拿到消息。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canWitness, loadScene, parseRemoteList, perceives, presencePath, saveScene } from '../src/group/presence.ts'
import { StoryStore } from '../src/store.ts'
import { existsSync } from 'node:fs'

const dir = mkdtempSync(join(tmpdir(), 'presence-selfcheck-'))
try {
  // 1) 往返（含 since：每个接入者自己的感知起点，别人进出场景不影响他；overhear 单向感知层）
  assert.deepEqual(loadScene(dir), { present: [], remote: [], overhear: [] }, '未配置时为空（全员现场由调用方决定）')
  saveScene(dir, {
    present: ['角色甲', '角色乙', ' 角色乙 '],
    remote: [{ character: '角色丙', perceive: '语音', note: '电话', since: 7 }],
    overhear: [{ character: '角色丁', perceive: '视听', note: '窗外' }],
  })
  assert.ok(existsSync(presencePath(dir)))
  const round1 = loadScene(dir)
  assert.deepEqual(round1, {
    present: ['角色甲', '角色乙'],
    remote: [{ character: '角色丙', perceive: '语音', note: '电话', since: 7 }],
    overhear: [{ character: '角色丁', perceive: '视听', note: '窗外' }],
  }, '去重、去空白、接入层（含 since）与单向感知层往返')
  assert.equal(parseRemoteList([{ character: '丁', perceive: '视听', since: 3 }])?.[0]?.since, 3, 'parseRemoteList 必须保留 since')

  // 接入解析：不是数组=未提供（接入情况不变）；数组=完整列表（空数组=全部挂断）
  assert.equal(parseRemoteList(undefined), undefined, '字段缺失=不变')
  assert.deepEqual(parseRemoteList([]), [], '空数组=接入结束')
  assert.deepEqual(parseRemoteList([{ character: ' 丙 ', perceive: '瞎写', note: '' }]), [{ character: '丙', perceive: '语音' }], '未知感知通道按语音（感知更少的一侧）')

  // 2) 感知解析
  assert.deepEqual(perceives({}), { hearing: true, sight: true }, '无感知字段=正常')
  assert.deepEqual(perceives({ 感知: '失聪' }), { hearing: false, sight: true })
  assert.deepEqual(perceives({ 感知: '失明' }), { hearing: true, sight: false })
  assert.deepEqual(perceives({ 感官: '失聪+失明' }), { hearing: false, sight: false })
  assert.deepEqual(perceives({ 身体状况: '被刺瞎了' }), { hearing: true, sight: false }, '自然语言描述也能识别')
  assert.deepEqual(perceives({ 身体状况: '被刺瞎了', 感知: '正常' }), { hearing: true, sight: true }, '显式 感知 字段可覆盖自然语言')
  assert.equal(canWitness({ 感知: '失聪' }), false, '有感知障碍者不作为自动目击者（保守：宁可少记，不可错记）')
  assert.equal(canWitness({ 感知: '失聪+失明' }), false, '又聋又瞎无法目击')
  assert.equal(canWitness({ 感知: '健康' }), true)
  assert.equal(canWitness({}), true, '无感知记录=正常')

  // 3) 可见性快照：场景内∩能感知
  const store = StoryStore.open(join(dir, 'g'), 'g')
  store.append('user', '你', '（当面说的话）', ['角色甲', '角色乙'], 'public')
  store.append('user', '你', '（私聊）', ['角色乙'], 'private')
  store.appendPresence(['角色甲'], '测试', [{ character: '角色丙', perceive: '语音', note: '电话' }], [{ character: '角色丁', perceive: '视听', note: '窗外' }])
  assert.deepEqual(store.lastScene(), {
    present: ['角色甲'],
    remote: [{ character: '角色丙', perceive: '语音', note: '电话' }],
    overhear: [{ character: '角色丁', perceive: '视听', note: '窗外' }],
  }, 'presence 行携带接入层与单向感知层（rebuild 的事实源）')
  assert.equal(store.lastSceneMsgCount(), 2, '接入起点 = 最近一次场景变更前已落盘的消息数（通道馈送从此切）')
  store.append('character', '角色甲', '（接话）', 'all', 'public')
  assert.equal(store.lastSceneMsgCount(), 2, '后续消息不改变接入起点')
  const msgs = store.effectiveMessages()
  const pub = msgs[0]
  const priv = msgs[1]
  assert.deepEqual(pub.visible_to, ['角色甲', '角色乙'], '公开消息写入在场者快照')
  assert.equal(pub.scope, 'public')
  assert.equal(priv.scope, 'private', '私聊带明确标记（UI 才不会误标）')
  assert.ok(StoryStore.isVisibleTo(pub, '角色甲') && !StoryStore.isVisibleTo(pub, '角色丙'), '不在场者看不到')
  assert.ok(StoryStore.isVisibleTo(priv, '角色乙') && !StoryStore.isVisibleTo(priv, '角色甲'), '私聊仅目标可见')

  console.log('场景接入/感知自检通过：现场+接入往返 · 感知解析 · 可见性快照与私聊标记')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
