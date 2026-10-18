/**
 * 轮次回退离线自检（SPEC §1.4；无需真实 API key，全部本地 mock 端点）：
 * 1) 每轮开始拍快照；回退 = 整份还原剧情状态（对话/在场/任务书/思维链/状态账本/记忆）。
 * 2) 轮内删除的对话在回退后复活；轮内手动改的账本回退到快照值。
 * 3) 配置类文件（角色资料/用户设定/个人知识库）**不**回退；角色改名保留（映射行不丢）。
 * 4) 连续回退；快照数量上限（最近 UNDO_KEEP 轮）；没有快照时拒绝。
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'
import { listSnapshots, undoInfo, UNDO_KEEP } from '../src/group/undo.ts'
import { loadCharacters } from '../src/group/persona.ts'
import { saveKnowledge, readKnowledge, updateCharacter, saveUserPersona, createGroup, createCharacter } from '../src/group/scaffold.ts'

const accName = '_selfcheck-undo'
const accDir = join(config.groupsDir, accName)
const settingsFile = join(config.root, 'settings.yaml')
const midFile = join(config.root, '中间判定.jsonl')
const hadSettings = existsSync(settingsFile)
const settingsBackup = hadSettings ? readFileSync(settingsFile, 'utf8') : undefined
const hadMid = existsSync(midFile)
const midBackup = hadMid ? readFileSync(midFile, 'utf8') : undefined
writeFileSync(settingsFile + '.selfcheck-bak', settingsBackup ?? '', 'utf8')
if (hadMid) rmSync(midFile, { force: true }) // 全局中间判定会让每轮多打 Jev，这里不需要

/** mock Jev：路由/知情等通用答案（choice 选第一个非「你」的选项）。 */
async function mockJev(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let buf = ''
    req.on('data', (c: Buffer) => { buf += c })
    req.on('end', () => {
      const body = JSON.parse(buf) as Record<string, unknown>
      const questions = (body.questions ?? {}) as Record<string, { type: string; criteria?: Record<string, string> }>
      const answers: Record<string, unknown> = {}
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === 'noul') answers[id] = { type: 'noul', noul: id.startsWith('told_') || id === 'briefs' ? 0.05 : 0.9 }
        else {
          const keys = Object.keys(q.criteria ?? {})
          // 场景判定固定"未移动"：让场景只由测试里的手动操作改变
          const pick = id === 'scene_change'
            ? (keys.find(k => k === '未移动') ?? keys[0] ?? '')
            : (keys.find(k => k !== '你' && k !== '未移动') ?? keys[0] ?? '')
          answers[id] = { type: 'choice', choice: pick, confidence: 0.9, probabilities: Object.fromEntries(keys.map(k => [k, k === pick ? 0.9 : 0])) }
        }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ model: 'jev-test', answers }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as { port: number }).port }
}

/** mock 对话模型：固定 SSE 文本。 */
async function mockChat(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    let buf = ''
    req.on('data', (c: Buffer) => { buf += c })
    req.on('end', () => {
      void buf
      res.setHeader('content-type', 'text/event-stream')
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '（测试思考）' } }] }) + '\n\n')
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '（测试回复）' } }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as { port: number }).port }
}

function writeTestSettings(dsPort: number, jevPort: number): void {
  writeFileSync(settingsFile, `activeId: pd\nrouterId: pj\nproviders:\n  - { id: pd, name: chat-mock, baseUrl: 'http://127.0.0.1:${dsPort}', apiKey: fake, model: fake-model, reasoningEffort: off }\n  - { id: pj, name: jev-mock, baseUrl: 'http://127.0.0.1:${jevPort}', apiKey: fake, model: jev-test, reasoningEffort: off }\n`, 'utf8')
}

const { GroupSession } = await import('../src/group/engine.ts')

/** 只用到 speak 的流（GroupSession 构造函数是私有的，不能写 InstanceType）。 */
async function speakAll(session: { speak: (text: string) => AsyncGenerator<{ type: string }> }, text: string): Promise<void> {
  for await (const _ of session.speak(text)) { /* 跑完 */ }
}

const chat = await mockChat()
const jev = await mockJev()

try {
  // ── A) 基本回退：轮内删除复活、账本回退、配置不回退、改名保留
  {
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST })
    writeTestSettings(chat.port, jev.port)
    const s1 = GroupSession.open(accName)
    await speakAll(s1, '第一句')
    assert.equal(undoInfo(accDir).remaining, 1, '每轮开始拍一张快照')
    const firstMsg = s1.snapshot().messages.find(m => m.text === '第一句')!
    assert.ok(firstMsg !== undefined)

    const s2 = GroupSession.open(accName)
    await speakAll(s2, '第二句')
    assert.equal(undoInfo(accDir).remaining, 2, '第二轮再拍一张')

    // 轮内用户操作：删掉第一轮的对话、手改账本、改名、改人设/用户设定/知识库
    s2.deleteMessage(firstMsg.id)
    s2.setLedger('角色甲', { 心理状态: '怒' })
    updateCharacter(accDir, '角色甲', { name: '甲二号', appearance: '（改过的外观）', background: '（改过的背景）', personality: '（改过的性格）', relationships: '（改过的关系）', scene: '' })
    saveUserPersona(accDir, { name: '我', text: '（改过的用户设定）' })
    saveKnowledge(join(accDir, '角色', '角色甲'), '（改过的知识库）')
    assert.ok(!s2.snapshot().messages.some(m => m.text === '第一句'), '删除已生效')

    const r = await s2.undoLastRound()
    assert.equal(r.text, '第二句', '返回被撤掉那轮的用户原文')
    assert.equal(undoInfo(accDir).remaining, 1, '消耗掉一张快照')

    const s3 = GroupSession.open(accName)
    const msgs = s3.snapshot().messages
    assert.ok(msgs.some(m => m.text === '第一句'), '轮内删掉的对话回退后复活')
    assert.ok(!msgs.some(m => m.text === '第二句'), '第二轮整轮消失')
    assert.equal(s3.ledgerOf('甲二号')['心理状态'] ?? '', '', '轮内手改的账本回退到快照值')
    // 配置类文件不回退
    assert.equal(loadCharacters(accDir).find(c => c.dirName === '角色甲')?.name, '甲二号', '角色改名不回退')
    assert.equal(s3.store.nameOf('角色甲'), '甲二号', '改名映射行必须保留（旧账目仍归到新名字下）')
    assert.equal(loadCharacters(accDir).find(c => c.dirName === '角色甲')?.appearance, '（改过的外观）', '角色资料不回退')
    assert.ok(readFileSync(join(accDir, '用户.md'), 'utf8').includes('（改过的用户设定）'), '用户设定不回退')
    assert.equal(readKnowledge(join(accDir, '角色', '角色甲')), '（改过的知识库）', '个人知识库不回退')

    // ── 再回退一轮：回到第一轮开始前（空日志）
    const r2 = await s3.undoLastRound()
    assert.equal(r2.text, '第一句', '第二张快照对应第一轮')
    const s4 = GroupSession.open(accName)
    assert.equal(s4.snapshot().messages.length, 0, '回到第一轮开始前：没有消息')
    assert.equal(undoInfo(accDir).remaining, 0, '快照用完')
  }

  // ── B) 保留上限：超过 UNDO_KEEP 轮后，最旧快照被淘汰
  {
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST })
    writeTestSettings(chat.port, jev.port)
    const s = GroupSession.open(accName)
    const rounds = UNDO_KEEP + 2
    for (let i = 1; i <= rounds; i++) await speakAll(s, `第${i}句`)
    assert.equal(listSnapshots(accDir).length, UNDO_KEEP, `只保留最近 ${UNDO_KEEP} 轮快照`)
    // 连续回退到上限，再回退应当报错
    let undone = 0
    for (let i = 0; i < UNDO_KEEP; i++) {
      const cur = GroupSession.open(accName)
      await cur.undoLastRound()
      undone++
    }
    assert.equal(undone, UNDO_KEEP)
    assert.equal(undoInfo(accDir).remaining, 0, '全部消耗完')
    const last = GroupSession.open(accName)
    const users = last.snapshot().messages.filter(m => m.role === 'user')
    assert.equal(users.length, rounds - UNDO_KEEP, '回到最早可回退点（前两轮保留）')
    await assert.rejects(() => last.undoLastRound(), '没有快照时必须报错（按钮置灰）')
  }

  // ── C) 没有快照：状态接口与回退都拒绝
  {
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST })
    writeTestSettings(chat.port, jev.port)
    const s = GroupSession.open(accName)
    assert.equal(undoInfo(accDir).remaining, 0, '新群没有可回退的轮次')
    assert.equal(s.backgroundIdle(), true, '没有后台任务时是空闲的')
    await assert.rejects(() => s.undoLastRound())
  }

  // ── D) 轮内手动切场景：回退后位置/场景回到本轮开始时的记录（且不会补一次现场所见）
  {
    rmSync(accDir, { recursive: true, force: true })
    createGroup(accDir, { era: '', world: '', tone: '', scene: '场景一', statusRecord: false, pinned: false }, [
      { name: '场景一', description: '（一）' },
      { name: '场景二', description: '（二）' },
    ])
    createCharacter(accDir, { name: '甲', appearance: 'a', background: 'b', personality: 'p', relationships: 'r', scene: '场景一' })
    writeTestSettings(chat.port, jev.port)
    const s1 = GroupSession.open(accName)
    await speakAll(s1, '第一句')
    const s2 = GroupSession.open(accName)
    await speakAll(s2, '第二句')
    assert.equal(s2.snapshot().scene, '场景一')
    s2.moveCurrentScene('场景二')
    assert.equal(s2.snapshot().scene, '场景二', '轮内手动切场景已生效')
    await s2.undoLastRound()
    const s3 = GroupSession.open(accName)
    assert.equal(s3.snapshot().scene, '场景一', '回退后当前场景回到本轮开始时')
    assert.equal(readFileSync(join(accDir, '在场.yaml'), 'utf8').includes('场景一'), true, '在场记录同样回到本轮开始时')
  }

  console.log(`轮次回退自检通过：每轮快照 · 整份还原（对话/在场/任务书/思维链/账本/记忆） · 轮内删除复活 · 账本回退 · 配置不回退 · 改名映射保留 · 连续回退 · 上限 ${UNDO_KEEP} 轮 · 无快照拒绝 · 轮内切场景回退`)
} finally {
  // 先还原真实配置，再关服务/删目录：任何一步抛错都不能把 mock 配置留在真实 settings.yaml 上
  if (hadSettings) writeFileSync(settingsFile, settingsBackup ?? '', 'utf8')
  else if (existsSync(settingsFile)) rmSync(settingsFile, { force: true })
  rmSync(settingsFile + '.selfcheck-bak', { force: true })
  if (hadMid) writeFileSync(midFile, midBackup ?? '', 'utf8')
  chat.server.close(); jev.server.close()
  rmSync(accDir, { recursive: true, force: true })
}
