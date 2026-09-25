/**
 * 引擎级离线自检（无需 API key；夹具群 groups/_selfcheck-engine，结束必删）——
 * 钉住本轮修复的核心行为：
 * 1) 剧情.jsonl 坏行忽略且新消息 id 不与幸存行撞号。
 * 2) 按 text 撤回的记忆：重启（重开回填）与 rebuild 重放都不复活。
 * 3) edit 活账本：记忆条目跟着消息新文本走；被撤回过的 mid 不复活。
 * 5) 改名：重名拒绝 + rename 名字链归一（ledger 重放不丢历史）。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { StoryStore } from '../src/store.ts'
import { GroupSession } from '../src/group/engine.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'
import { applyLedgerEvent, emptyFiles } from '../src/group/status.ts'
import { createCharacter, updateCharacter } from '../src/group/scaffold.ts'

const accName = '_selfcheck-engine'
const accDir = join(config.groupsDir, accName)
const tmp = mkdtempSync(join(tmpdir(), 'engine-selfcheck-'))

try {
  // ── 1) 坏行忽略 + id 续号（store 级）
  {
    const dir = join(tmp, 'badline')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '剧情.jsonl'), [
      '{"type":"header","group":"g","created":"2026-01-01T00:00:00Z","v":1}',
      '{"type":"msg","id":1,"role":"user","name":"你","text":"一","round":1,"visible_to":"all","scope":"public","ts":"t"}',
      '{"type":"msg","id":2,"role":"user","name":"你","text":"二","round":2,"visible_to":"all","scope":"public","ts":"t"}',
      '{"type":"msg","id":3,"role":"user","name":"你","text":"坏行——故意截断', // 尾部半行
      '{"type":"msg","id":4,"role":"user","name":"你","text":"四","round":4,"visible_to":"all","scope":"public","ts":"t"}',
    ].join('\n') + '\n', 'utf8')
    const s = StoryStore.open(dir, 'g')
    assert.equal(s.messages.length, 3, '坏行必须被忽略，不让整份日志打不开')
    assert.deepEqual(s.messages.map(m => m.id), [1, 2, 4])
    const next = s.append('user', '你', '新消息')
    assert.equal(next.id, 5, '新 id = 现存最大 id + 1（跳过坏行缺口，不与幸存行撞号）')
  }

  // ── 2-5) 引擎级（夹具群）
  rmSync(accDir, { recursive: true, force: true })
  buildGroupFixture(accDir, { chars: TEST_CAST.slice(0, 2) })
  // 先落一条只有角色甲可见的消息，再开会话 → open 时自动回填登记 mid=1
  StoryStore.open(accDir, accName).append('user', '你', '我其实是卧底', ['角色甲'])

  // ── 2) 按 text 撤回：重启 + 重放都不复活
  {
    const s1 = GroupSession.open(accName)
    assert.equal(s1.memoryOf('角色甲').length, 1, 'open 时应已回填 1 条亲历')
    const n = s1.retractKnowledge('角色甲', { text: '卧底' })
    assert.equal(n, 1, '按 text（包含匹配）应命中 1 条')
    // 重启：新会话的回填不得复活
    const s2 = GroupSession.open(accName)
    assert.equal(s2.memoryOf('角色甲').length, 0, '重启后回填不得复活被撤回的条目（suppressed 集合收到 mid）')
    // rebuild 重放：ledger 逐条落盘（mid 型），重放结果一致
    const replay = emptyFiles()
    const store = StoryStore.open(accDir, accName)
    for (const l of store.allLines) {
      if (l.type === 'ledger' && store.nameOf(l.character) === '角色甲') applyLedgerEvent(replay, l.op, l.section, l.content, 0)
    }
    assert.equal(replay.memory.filter(e => e.text.includes('卧底')).length, 0, 'rebuild 重放后撤回条目不得复活')
  }

  // ── 3) edit 活账本
  {
    const s = GroupSession.open(accName)
    // 此时 mid=1 已被撤回（suppressed）：edit 不得让它复活
    s.editMessage(1, '我是商人')
    assert.ok(!s.memoryOf('角色甲').some(e => e.text.includes('商人') || e.text.includes('卧底')), '被撤回的 mid 不得因 edit 复活')
    // 再落一条可见消息并回填，然后 edit：条目文本必须跟着新文本走
    const store = StoryStore.open(accDir, accName)
    store.append('user', '你', '钥匙藏在花盆下', ['角色甲'])
    const s3 = GroupSession.open(accName)
    const before = s3.memoryOf('角色甲')
    const entry = before.find(e => e.text.includes('花盆'))
    assert.ok(entry !== undefined, '新消息应已回填')
    s3.editMessage(entry.mid!, '钥匙在门垫下')
    const after = s3.memoryOf('角色甲')
    assert.ok(!after.some(e => e.text.includes('花盆')), '旧文本不得残留在记忆里（活账本）')
    assert.ok(after.some(e => e.text.includes('门垫')), '记忆条目必须同步改写为新文本')
    // 账本行物理改写：日志里旧原文消失（当前上下文快照语义），重放一致（重新从磁盘读日志——engine 内的 store 是另一个内存实例）
    const replay2 = emptyFiles()
    const storeFresh = StoryStore.open(accDir, accName)
    for (const l of storeFresh.allLines) {
      if (l.type === 'ledger' && storeFresh.nameOf(l.character) === '角色甲') applyLedgerEvent(replay2, l.op, l.section, l.content, 0)
    }
    assert.ok(!replay2.memory.some(e => e.text.includes('花盆')), '重放后同样只有新文本')
    assert.ok(replay2.memory.some(e => e.text.includes('门垫')), '重放后新文本在账')
    assert.ok(!readFileSync(join(accDir, '剧情.jsonl'), 'utf8').includes('花盆'), '手改后旧原文不得残留在日志里（含账本行）')
  }


  // ── 4b) 删除消息 = 记忆一并撤回（所有引用该消息的账本条目消失且不复活）+ 日志物理移除
  {
    const s = GroupSession.open(accName)
    const store = StoryStore.open(accDir, accName)
    store.append('user', '你', '（机密口令：晚霞）', ['角色甲', '角色乙'])
    const s2 = GroupSession.open(accName)
    assert.ok(s2.memoryOf('角色甲').some(e => e.text.includes('晚霞')), '甲应已登记该消息')
    assert.ok(s2.memoryOf('角色乙').some(e => e.text.includes('晚霞')), '乙应已登记该消息')
    const delId = store.messages.at(-1)!.id
    s2.deleteMessage(delId)
    assert.ok(!readFileSync(join(accDir, '剧情.jsonl'), 'utf8').includes('晚霞'), '删除 = 消息行物理移除（原始日志不保留原文）')
    assert.equal(StoryStore.open(accDir, accName).messages.some(m => m.id === delId), false, '重启后日志里也没有该消息')
    const s3 = GroupSession.open(accName)
    assert.ok(!s3.memoryOf('角色甲').some(e => e.text.includes('晚霞')), '删除后甲的记忆必须同步清除')
    assert.ok(!s3.memoryOf('角色乙').some(e => e.text.includes('晚霞')), '删除后乙的记忆必须同步清除')
    assert.ok(!s3.snapshot().messages.some(m => m.text.includes('晚霞')), '删除的消息从可见视图消失')
    assert.equal(s3.store.append('user', '你', '（占位）').id > delId, true, '删除后的 id 不得复用')
  }

  // ── 5) 改名：重名拒绝 + 名字链归一
  {
    createCharacter(accDir, { name: '角色丁', appearance: '', background: '', personality: '', relationships: '' })
    updateCharacter(accDir, '角色丁', { name: '角色戊', appearance: '', background: '改', personality: '', relationships: '' })
    assert.throws(() =>
      updateCharacter(accDir, '角色丁', { name: '角色甲', appearance: '', background: '', personality: '', relationships: '' }),
    /已被/, '改名不得与现存角色重名')
    const store = StoryStore.open(accDir, accName)
    assert.equal(store.nameOf('角色丁'), '角色戊', 'rename 名字链必须归一到当前名')
    assert.equal(store.nameOf('角色甲'), '角色甲', '未改名的角色不受影响')
    assert.ok(store.allLines.some(l => l.type === 'rename' && l.from === '角色丁' && l.to === '角色戊'), 'rename 行必须落盘')
    rmSync(join(accDir, '角色', '角色丁'), { recursive: true, force: true }) // 清理测试角色目录
  }

  console.log('引擎离线自检通过：坏行忽略·id续号 · text撤回不复活(重启/重放) · edit活账本(含撤回尊重) · 删除消息=记忆一并撤回 · 改名名字链')
} finally {
  rmSync(accDir, { recursive: true, force: true })
  rmSync(tmp, { recursive: true, force: true })
}
