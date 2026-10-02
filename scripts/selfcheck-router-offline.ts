/**
 * 快/慢双路径离线自检（无需真实 API key；全部本地 mock 端点）：
 * 1) jevDecide：原生 systemone 响应解析、HTTP 错误抛出、超时抛出。
 * 2) jevRoute：路由命中/低置信回退/名单外回退/noul 阈值变换（进场/离场/模糊保持）/接入判断/perceive
 *    /额外记忆一段触发（told_X）/状态总门（state_dirty）。
 * 3) jevExtraRounds：二段逐轮判定（≥0.75 命中、低分不移植、故障不移植）。
 * 4) missingRounds/transplantRounds：缺失轮计算与逐字移植（source=额外得知，带 mid）。
 * 5) 端到端 speak：快路径（Jev 路由）→ 合并判定（知情+总门+转告+接力一次调用）→ 记账门控
 *    （无变化零 DeepSeek 调用）→ 额外记忆移植（幂等：无缺失轮不再触发二段）→
 *    接力累计衰减（刚发言压0：不可能连续发言；权重每判定乘0.8且重新发言不重置；无硬上限，衰减最终判回用户）；
 *    Jev 故障 → 整轮回退 deepseek 完整总管（记账随总管结果即时应用）。
 * settings.yaml 若存在则备份、结束恢复（测试注入 routerId/activeId 指向本地 mock）。
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync as fsReadFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { createScene } from '../src/group/scene.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'

const accName = '_selfcheck-router'
const accDir = join(config.groupsDir, accName)
const settingsFile = join(config.root, 'settings.yaml')
const hadSettings = existsSync(settingsFile)
const backup = hadSettings ? fsReadFileSync(settingsFile, 'utf8') : undefined
// 备份落盘：进程被硬崩溃打死时 finally 不会执行，磁盘上的孤儿备份供 server/cli 启动时自愈
writeFileSync(settingsFile + '.selfcheck-bak', backup ?? '', 'utf8')
// 规则夹具（临时写、finally 恢复）：带标记的规则文本用于钉"规则只进角色生成上下文"的注入边界
const rulesFile = join(config.root, '规则.md')
const hadRules = existsSync(rulesFile)
const rulesBackup = hadRules ? fsReadFileSync(rulesFile, 'utf8') : undefined
const RULES_MARKER = '（测试规则·仅角色可见标记）'
writeFileSync(rulesFile, RULES_MARKER + '\n', 'utf8')
// 规则.jsonl 存在时优先于 规则.md 读取：夹具先移除它，注入边界按 规则.md 的标记断言
const rulesListFile = join(config.root, '规则.jsonl')
const hadRulesList = existsSync(rulesListFile)
const rulesListBackup = hadRulesList ? fsReadFileSync(rulesListFile, 'utf8') : undefined
if (hadRulesList) rmSync(rulesListFile, { force: true })

/** mock Jev：answers（固定）或 answersSeq（按第 N 次请求取，超出重复最后一个）；可注入故障（500 / 慢响应）。 */
async function mockJev(script: { answers?: Record<string, unknown> | Array<Record<string, unknown>>; fail?: boolean; slowMs?: number }): Promise<{ server: Server; port: number; hits: Array<Record<string, unknown>> }> {
  const hits: Array<Record<string, unknown>> = []
  const server = createServer((req, res) => {
    let buf = ''
    req.on('data', (c: Buffer) => { buf += c })
    req.on('end', () => {
      const answers: Record<string, unknown> | undefined = Array.isArray(script.answers)
        ? script.answers[Math.min(hits.length, script.answers.length - 1)]
        : script.answers
      hits.push({ url: req.url, body: JSON.parse(buf) })
      if (script.slowMs !== undefined) {
        setTimeout(() => { res.statusCode = 500; res.end() }, script.slowMs)
        return
      }
      if (script.fail === true) { res.statusCode = 500; res.end(); return }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ model: 'jev-test', answers: answers ?? {} }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, port, hits }
}

interface DeepseekHit { kind: 'route' | 'bookkeep' | 'scene' | 'offstory' | 'pov' | 'stream'; body: Record<string, unknown> }

/** mock deepseek：route/record_round/record_scene/record_offstory/render_memory tool-call 与角色 SSE 流（可带 reasoning_content 增量）。 */
async function mockDeepseek(script: {
  route?: Record<string, unknown>
  bookkeep?: Record<string, unknown>
  scene?: string
  offstory?: Array<{ summary: string; participants: string[] }>
  povMap?: Record<string, string>
  pov?: string
  streamText?: string
  reasoning?: string
}): Promise<{ server: Server; port: number; hits: DeepseekHit[] }> {
  const hits: DeepseekHit[] = []
  const server = createServer((req, res) => {
    let buf = ''
    req.on('data', (c: Buffer) => { buf += c })
    req.on('end', () => {
      const body = JSON.parse(buf) as Record<string, unknown>
      const tools = JSON.stringify(body.tools ?? [])
      if (tools.includes('route_and_remember')) {
        hits.push({ kind: 'route', body })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ function: { name: 'route_and_remember', arguments: JSON.stringify(script.route ?? {}) } }] } }] }))
        return
      }
      if (tools.includes('record_round')) {
        hits.push({ kind: 'bookkeep', body })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ function: { name: 'record_round', arguments: JSON.stringify(script.bookkeep ?? {}) } }] } }] }))
        return
      }
      if (tools.includes('record_scene')) {
        hits.push({ kind: 'scene', body })
        const sceneArgs = JSON.stringify({ scene_summary: script.scene ?? '（现场无异样）' })
        const sceneBody = JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ function: { name: 'record_scene', arguments: sceneArgs } }] } }] })
        res.setHeader('content-type', 'application/json')
        res.end(sceneBody)
        return
      }
      if (tools.includes('record_offstory')) {
        hits.push({ kind: 'offstory', body })
        const offArgs = JSON.stringify({ events: script.offstory ?? [] })
        const offBody = JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ function: { name: 'record_offstory', arguments: offArgs } }] } }] })
        res.setHeader('content-type', 'application/json')
        res.end(offBody)
        return
      }
      if (tools.includes('render_memory')) {
        hits.push({ kind: 'pov', body })
        const who = /以(.+?)的限知视角/.exec(buf)?.[1] ?? ''
        const povArgs = JSON.stringify({ memory: script.povMap?.[who] ?? script.pov ?? '（视角记忆）' })
        const povBody = JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ function: { name: 'render_memory', arguments: povArgs } }] } }] })
        res.setHeader('content-type', 'application/json')
        res.end(povBody)
        return
      }
      hits.push({ kind: 'stream', body })
      res.setHeader('content-type', 'text/event-stream')
      if (script.reasoning !== undefined) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: script.reasoning } }] }) + '\n\n')
      }
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: script.streamText ?? '（测试回复）' } }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, port, hits }
}

const baseInput = (port: number): Parameters<typeof jevRoute>[0] => ({
  llm: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'fake', model: 'jev-test' },
  roster: [{ name: '角色甲' }, { name: '角色乙' }],
  rosterLines: ['角色甲｜直率', '角色乙｜谨慎'],
  allNames: ['角色甲', '角色乙', '角色丙'],
  present: ['角色甲'],
  remote: [],
  overhear: [],
  presentNotes: ['角色甲'],
  statusNotes: [],
  recent: '你：（测试发言）',
  userText: '大家好',
  tone: '',
  timeoutMs: 1000,
  scenes: [
    { name: '场景一', description: '（测试描述一）' },
    { name: '场景二', description: '（测试描述二）' },
  ],
  activeScene: '场景一',
  locations: { 角色甲: '场景一', 角色乙: '场景一', 角色丙: '场景二' },
})

const writeTestSettings = (dsPort: number, jevPort: number): void => {
  writeFileSync(settingsFile, `activeId: pd\nrouterId: pj\nproviders:\n  - { id: pd, name: deepseek-mock, baseUrl: 'http://127.0.0.1:${dsPort}', apiKey: fake, model: fake-model, reasoningEffort: off }\n  - { id: pj, name: jev-mock, baseUrl: 'http://127.0.0.1:${jevPort}', apiKey: fake, model: jev-test, reasoningEffort: off }\n`, 'utf8')
}

const { jevRoute, jevAfterReply, jevExtraRounds } = await import('../src/group/host.ts')

try {
  // ── 1) jevRoute：命中与位置判定（location choice = 唯一在场机制）+ 链接推导
  //        （perceive=有没有办法知道 / interact=能不能实时互动）+ 转告触发 + 状态总门
  {
    const m = await mockJev({ answers: {
      next_speaker: { type: 'choice', choice: '角色乙', confidence: 0.92, probabilities: { 角色甲: 0.08, 角色乙: 0.92 } },
      scene_change: { type: 'choice', choice: '未移动', confidence: 0.9, probabilities: {} },
      location_角色甲: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} },
      location_角色乙: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} },
      location_角色丙: { type: 'choice', choice: '场景二', confidence: 0.9, probabilities: {} },
      perceive_角色乙: { type: 'noul', noul: 0.9 },
      interact_角色乙: { type: 'noul', noul: 0.9 },  // 乙被判定同场景 → 不应有链接
      perceive_角色丙: { type: 'noul', noul: 0.95 },
      interact_角色丙: { type: 'noul', noul: 0.1 },  // 能知道 + 不能互动 → 单向感知（偷听）
      mode_角色乙: { type: 'choice', choice: '语音', confidence: 0.9, probabilities: {} },
      mode_角色丙: { type: 'choice', choice: '视听', confidence: 0.9, probabilities: {} },
      knows_角色甲: { type: 'noul', noul: 0.3 },    // 知情判定：甲感知不到本轮发言（<0.5 不给）
      knows_角色乙: { type: 'noul', noul: 0.95 },
      knows_角色丙: { type: 'noul', noul: 0.9 },
      told_角色甲: { type: 'noul', noul: 0.2 },
      told_角色乙: { type: 'noul', noul: 0.3 },
      told_角色丙: { type: 'noul', noul: 0.9 },     // 转告触发：只有丙过线
      state_dirty: { type: 'noul', noul: 0.05 },    // 纯聊天：不触发记账
    } })
    const r = await jevRoute(baseInput(m.port))
    assert.ok(r !== undefined, '命中且高置信应返回结果')
    assert.equal(r?.picked, '角色乙')
    assert.match(r?.reason ?? '', /Jev·置信0\.92/)
    assert.equal(r?.sceneChange, '', '未移动 → 空串（不落场景行）')
    assert.deepEqual(r?.locationChoice?.['角色甲'], '场景一', '位置判定：甲留场景一')
    assert.deepEqual(r?.locationChoice?.['角色丙'], '场景二', '位置判定：丙在场景二')
    const over = r?.links?.overhear.find(l => l.character === '角色丙')
    assert.ok(over !== undefined, '丙能知道但不能互动 → 单向感知层')
    assert.equal(over?.perceive, '视听')
    assert.equal(r?.links?.remote.length, 0, '无双向接入')
    assert.ok(!r?.knows.has('角色甲'), '知情 <0.5 的角色不得进知情名单')
    assert.ok(r?.knows.has('角色乙') && r?.knows.has('角色丙'), '能感知到的角色必须在知情名单（知情=原文移植）')
    assert.deepEqual([...(r?.told ?? [])], ['角色丙'], '额外记忆一段触发：只有过线的丙')
    assert.equal(r?.stateDirty, false, 'state_dirty 0.05 → 不需要记账')
    m.server.close()
  }

  // ── 2) 低置信 → 路由置空回退；名单外 → 同；回退必须落判定日志（不再静默）
  {
    const logs: Array<Record<string, unknown>> = []
    const m = await mockJev({ answers: {
      next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.3, probabilities: {} },
      location_角色甲: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} },
    } })
    const r = await jevRoute({ ...baseInput(m.port), log: e => logs.push(e) })
    assert.ok(r !== undefined && r.picked === '', '置信度低于阈值：路由必须置空（回退完整总管）')
    assert.ok(r?.reason.includes('回退'), '理由必须说明路由已回退')
    assert.ok(logs.some(l => typeof l.note === 'string' && String(l.note).includes('回退')), '路由回退必须落判定日志（不再盲审）')
    assert.ok(logs.every(l => l.answers !== undefined), '回退日志必须带 Jev 原始答案')
    m.server.close()
    const logs2: Array<Record<string, unknown>> = []
    const m2 = await mockJev({ answers: {
      next_speaker: { type: 'choice', choice: '不存在的人', confidence: 0.99, probabilities: {} },
      location_角色甲: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} },
    } })
    const r2 = await jevRoute({ ...baseInput(m2.port), log: e => logs2.push(e) })
    assert.ok(r2 !== undefined && r2.picked === '', '名单外的选择：路由置空回退')
    assert.ok(logs2.some(l => typeof l.note === 'string' && String(l.note).includes('回退') && l.route === '不存在的人'), '名单外回退必须记录 Jev 选了谁')
    m2.server.close()
  }

  // ── 2b) 路由不可用但位置/知情判定明确：路由回退、位置/知情照常生效（不连坐）
  {
    const logs: Array<Record<string, unknown>> = []
    const m = await mockJev({ answers: {
      next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.22, probabilities: {} },
      scene_change: { type: 'choice', choice: '未移动', confidence: 0.9, probabilities: {} },
      location_角色甲: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} },
      location_角色乙: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} },
      location_角色丙: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} },  // 丙被明确描写进场
      knows_角色甲: { type: 'noul', noul: 0.9 },
      knows_角色乙: { type: 'noul', noul: 0.2 },
      knows_角色丙: { type: 'noul', noul: 0.8 },
    } })
    const r = await jevRoute({ ...baseInput(m.port), log: e => logs.push(e) })
    assert.ok(r !== undefined && r.picked === '', '路由置信 0.22 → 路由置空回退')
    assert.deepEqual(r?.locationChoice?.['角色丙'], '场景一', '位置判定不与路由连坐：丙照常落位场景一')
    assert.ok(r?.knows.has('角色甲') && r?.knows.has('角色丙'), '知情判定照常生效')
    assert.ok(!r?.knows.has('角色乙'), '知情阈值照常拦截')
    assert.ok(logs.some(l => typeof l.note === 'string' && String(l.note).includes('照常生效')), '回退日志必须说明位置/知情判定仍然生效')
    m.server.close()
  }

  // ── 3) 模糊区间保持现状；故障/超时回退；缺答案的安全侧默认
  {
    const m = await mockJev({ answers: {
      next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: {} },
      location_角色甲: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} }, // 与记录一致：维持
      location_角色乙: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} },
      location_角色丙: { type: 'choice', choice: '场景二', confidence: 0.9, probabilities: {} },
      perceive_角色乙: { type: 'noul', noul: 0.5 }, // 模糊：不达"能知道"线 → 不进任何层
      interact_角色乙: { type: 'noul', noul: 0.5 },
      perceive_角色丙: { type: 'noul', noul: 0.5 },
      interact_角色丙: { type: 'noul', noul: 0.5 },
      mode_角色乙: { type: 'choice', choice: '语音', confidence: 0.9, probabilities: {} },
      mode_角色丙: { type: 'choice', choice: '语音', confidence: 0.9, probabilities: {} },
      knows_角色甲: { type: 'noul', noul: 0.6 }, // 知情模糊：甲保持在名单（现场保底）
      knows_角色乙: { type: 'noul', noul: 0.6 },
      knows_角色丙: { type: 'noul', noul: 0.6 },
      // told_* / state_dirty 均缺答案
    } })
    const r = await jevRoute(baseInput(m.port))
    assert.deepEqual(r?.locationChoice?.['角色甲'], '场景一', '位置答案与记录一致 = 维持现状')
    assert.ok(r?.knows.has('角色甲'), '知情模糊时现场者保持（代码保底：宁可多记，可撤回）')
    assert.equal(r?.told.size, 0, '转告缺答案 = 未触发（二段判定不该乱跑）')
    assert.equal(r?.stateDirty, true, '状态总门缺答案 = 需要记账（安全侧：宁可白跑不可丢账）')
    m.server.close()
    const f = await mockJev({ fail: true })
    assert.equal(await jevRoute(baseInput(f.port)), undefined, 'HTTP 故障必须回退')
    f.server.close()
    const s = await mockJev({ slowMs: 300 })
    assert.equal(await jevRoute({ ...baseInput(s.port), timeoutMs: 60 }), undefined, '超时必须回退')
    s.server.close()
  }

  // ── 3b) jevExtraRounds：二段逐轮判定
  {
    const llm = { baseUrl: '', apiKey: 'fake', model: 'jev-test' }
    const m = await mockJev({ answers: {
      round_1: { type: 'noul', noul: 0.3 },  // 低分：不属于转告范围
      round_2: { type: 'noul', noul: 0.8 },  // ≥0.75：命中
      round_3: { type: 'noul', noul: 0.75 }, // 恰在阈值：命中
    } })
    llm.baseUrl = `http://127.0.0.1:${m.port}`
    const got = await jevExtraRounds({ llm, character: '角色丙', retoldText: '我把一件事转告给了他', missing: [{ round: 1, summary: '你：（测试发言）' }, { round: 2, summary: '角色甲：（测试发言）' }, { round: 3, summary: '角色乙：（测试发言）' }], timeoutMs: 1000 })
    assert.deepEqual([...(got ?? [])].sort(), [2, 3], '≥0.75 的轮必须命中，低分轮不给')
    m.server.close()
    const f = await mockJev({ fail: true })
    llm.baseUrl = `http://127.0.0.1:${f.port}`
    assert.equal(await jevExtraRounds({ llm, character: '角色丙', retoldText: 'x', missing: [{ round: 1, summary: 'y' }], timeoutMs: 1000 }), undefined, '二段故障 = 不移植（维持现状）')
    f.server.close()
  }

  // ── 3c) missingRounds / transplantRounds：缺失轮计算与逐字移植
  {
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST, statusRecord: true })
    const { StoryStore } = await import('../src/store.ts')
    const { missingRounds, transplantRounds } = await import('../src/group/knowledge.ts')
    const store = StoryStore.open(accDir, accName)
    store.append('user', '你', '第一轮发言', ['角色甲', '角色乙'])
    store.append('character', '角色甲', '（甲发言）我喜欢乙。', ['角色甲', '角色乙'])
    store.append('user', '你', '第二轮的事', 'all')
    const mem = [{ source: '亲历', mid: 1, round: 1, text: '你：第一轮发言' }]
    const missing = missingRounds(store, mem)
    assert.deepEqual(missing.map(x => x.round), [1, 2], '第1轮（缺甲发言）与第2轮（全缺）都是缺失轮')
    assert.ok(missing[0].summary.startsWith('角色甲：'), '摘要 = 轮内首条缺失消息')
    const added = transplantRounds(store, '角色甲', mem, new Set([1]))
    assert.equal(added.length, 1, '只补第1轮里他缺的那条')
    assert.equal(added[0]?.mid, 2)
    assert.equal(added[0]?.source, '额外得知')
    assert.equal(added[0]?.round, 1)
    assert.equal(added[0]?.text, '你自己说过：（甲发言）我喜欢乙。', '逐字原文 + 说话人标识（自己的发言 = 你自己说过），无改写')
    assert.deepEqual(missingRounds(store, mem).map(x => x.round), [2], '补过的轮不再缺失（幂等基础）')
  }

  // ── 4) 端到端：快路径路由 → 知情名单（原文移植）→ 合并判定 → 记账门控（回复脏 → 恰一次记账）
  {
    const ds = await mockDeepseek({
      bookkeep: {
        状态账本: [{ character: '角色甲', 心理状态: '愉快' }],
        presence_updates: [{ present: ['角色乙'], reason: '记账员越权试图改名单' }],
      },
      streamText: '（甲压低声音）我只跟你说。',
    })
    const jev = await mockJev({ answers: [
      { // 第1次：主判定 → 甲接话；丙被偷听判定覆盖；用户发言本身不脏（不触发用户消息记账）
        next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.88, probabilities: {} },
        present_角色甲: { type: 'noul', noul: 0.98 },
        present_角色乙: { type: 'noul', noul: 0.9 },
        present_角色丙: { type: 'noul', noul: 0.05 },
        perceive_角色丙: { type: 'noul', noul: 0.9 },  // 丙能知道这里的事
        interact_角色丙: { type: 'noul', noul: 0.1 },  // 但不能互动 → 单向感知（在门外偷听）
        mode_角色丙: { type: 'choice', choice: '语音', confidence: 0.9, probabilities: {} },
        knows_角色甲: { type: 'noul', noul: 0.9 },
        knows_角色乙: { type: 'noul', noul: 0.2 },     // 知情判定：乙听不到（对话是压低了声音的）
        knows_角色丙: { type: 'noul', noul: 0.9 },     // 偷听者能感知到 → 知情（原文移植）
        told_角色甲: { type: 'noul', noul: 0.1 },
        told_角色乙: { type: 'noul', noul: 0.1 },
        told_角色丙: { type: 'noul', noul: 0.1 },
        state_dirty: { type: 'noul', noul: 0.1 },
      },
      { // 第2次：甲回复的合并判定（知情 + 总门 + 转告 + 接力）
        knows_角色乙: { type: 'noul', noul: 0.9 },
        knows_角色丙: { type: 'noul', noul: 0.9 },
        told_角色乙: { type: 'noul', noul: 0.1 },
        told_角色丙: { type: 'noul', noul: 0.1 },
        state_dirty: { type: 'noul', noul: 0.95 },     // 回复脏 → 恰好一次后台记账
        next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
      },
    ] })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST, statusRecord: true })
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    session.setScene({ present: ['角色甲', '角色乙'], remote: [], overhear: [] }, '测试初始') // 丙在门外
    const events: Array<{ type: string; text?: string; picked?: string }> = []
    for await (const ev of session.speak('我只跟你说，别让乙知道')) {
      events.push(ev.type === 'route' ? { type: 'route', picked: ev.picked } : { type: ev.type, text: 'text' in ev ? ev.text : undefined })
    }
    const types = events.map(e => e.type)
    assert.ok(types.includes('route'), '必须有路由事件')
    assert.equal(events.find(e => e.type === 'route')?.picked, '角色甲', '快路径的路由结果必须生效')
    const replyIdx = types.indexOf('reply')
    assert.ok(replyIdx >= 0, '必须有回复事件')
    assert.ok(events.some(e => e.type === 'info' && (e.text ?? '').includes('后台')), '记账门控通过：后台记账提示出现')
    assert.ok(!types.includes('ledger'), '后台记账不再发实时 ledger 事件（流及时结束，不锁输入）')
    assert.equal(events.filter(e => e.type === 'route').length, 1, '接力判给用户：只有一个 route 事件')
    assert.equal(ds.hits.filter(h => h.kind === 'route').length, 0, '快路径成功时不得再调 deepseek 路由')
    assert.equal(jev.hits.length, 2, 'Jev 调用：1 主判定 + 1 合并判定')

    // 等后台记账落盘（后台任务与流并行，需轮询等待）
    for (let i = 0; i < 40; i++) {
      const st = fsReadFileSync(join(accDir, '角色', '角色甲', '状态.yaml'), 'utf8')
      if (st.includes('愉快')) break
      await new Promise(r => setTimeout(r, 250))
    }
    assert.equal(ds.hits.filter(h => h.kind === 'bookkeep').length, 1, '记账门控：仅回复脏 → 恰好一次后台记账')
    const stFinal = fsReadFileSync(join(accDir, '角色', '角色甲', '状态.yaml'), 'utf8')
    assert.ok(stFinal.includes('愉快'), '后台记账必须把状态账本快照落盘')
    // 记账员无名册权：bookkeeper 越权输出的 presence_updates 必须被忽略
    assert.ok(session.snapshot().present.includes('角色甲') && session.snapshot().present.includes('角色乙'), '记账员不得改动场景名册（权力已摘除）')

    // 规则注入边界：规则文本只出现在角色生成上下文——Jev 主判定/合并判定与记账请求体一律不含
    assert.ok(jev.hits.length > 0 && jev.hits.every(h => !JSON.stringify(h.body).includes(RULES_MARKER)),
      'Jev 判定（主判定/合并判定）的 state 不得包含用户规则')
    assert.ok(ds.hits.filter(h => h.kind === 'bookkeep').every(h => !JSON.stringify(h.body).includes(RULES_MARKER)),
      '记账员提示词不得包含用户规则')
    const streamHits = ds.hits.filter(h => h.kind === 'stream')
    assert.ok(streamHits.length > 0 && streamHits.every(h => JSON.stringify(h.body).includes(RULES_MARKER)),
      '角色生成上下文必须包含用户规则（注入对象仅角色）')
    // 判定日志（判定.jsonl，只给人看）：判定/记账必须有完整记录，带原始答案与耗时
    const judgeRaw = fsReadFileSync(join(accDir, '判定.jsonl'), 'utf8')
    assert.ok(judgeRaw.includes('"phase":"主判定"') && judgeRaw.includes('"phase":"回复判定"'), '主判定与回复判定必须落判定日志')
    assert.ok(judgeRaw.includes('"phase":"记账"'), '记账结果必须落判定日志')
    assert.ok(judgeRaw.includes('"answers"'), '判定日志必须带每道题的原始答案')
    const judgeMainRow = JSON.parse(judgeRaw.split(String.fromCharCode(10)).find(l => l.includes('"phase":"主判定"'))!) as Record<string, unknown>
    assert.ok(typeof judgeMainRow.elapsedMs === 'number' && Array.isArray(judgeMainRow.knows) && typeof judgeMainRow.stateDirty === 'boolean', '主判定行必须带耗时/知情名单/状态门')

    // 知情名单 = visible_to：乙（感知不到）不在；甲与偷听的丙在
    const userMsg = session.snapshot().messages.find(m => m.text === '我只跟你说，别让乙知道')
    assert.deepEqual([...(userMsg?.visible_to === 'all' ? [] : userMsg?.visible_to ?? [])].sort(), ['角色甲', '角色丙'].sort(), '知情名单必须由 Jev 判定写进快照（含通道/单向感知者）')
    // 单向感知者：不能发言，但知情（记忆 = 原文移植）
    assert.ok(session.overhearLinks().some(l => l.character === '角色丙'), 'Jev 的单向感知判断必须生效')
    assert.ok(!session.speakableNames().includes('角色丙'), '单向感知者不能发言')
    const memOf = (n: string): string => {
      try { return fsReadFileSync(join(accDir, '角色', n, '记忆.jsonl'), 'utf8') } catch { return '' }
    }
    assert.ok(!memOf('角色乙').includes('别让乙知道'), '感知不到的角色不得入账')
    assert.ok(memOf('角色丙').includes('别让乙知道'), '偷听者的知情 = 原文移植进账本（无总结）')
    assert.ok(memOf('角色甲').includes('别让乙知道'), '现场感知者必须入账')
    // 原文移植校验：账本条目必须是逐字原文（含动作/说话人标识），不是总结改写
    const jiaMem = JSON.parse('[' + memOf('角色甲').trim().split(String.fromCharCode(10)).filter(l => l !== '').join(',') + ']') as Array<{ text: string; mid?: number }>
    const line = jiaMem.find(e => e.text.includes('别让乙知道'))
    assert.ok(line !== undefined && line.mid !== undefined, '亲历条目必须带 mid（原文移植）')
    assert.ok(/：我只跟你说，别让乙知道$/.test(line.text), '条目必须是原文+说话人标识，实得：' + line.text)
    ds.server.close(); jev.server.close()
  }

  // ── 4b) 接力：A 说完 → 合并判定判给乙 → 乙说完 → 判给用户 → 本轮结束（两个 route 事件）
  {
    const ds = await mockDeepseek({ streamText: '（接话）嗯。' })
    const knowsAll = {
      knows_角色甲: { type: 'noul', noul: 0.9 },
      knows_角色乙: { type: 'noul', noul: 0.9 },
      knows_角色丙: { type: 'noul', noul: 0.9 },
    }
    const toldLow = {
      told_角色甲: { type: 'noul', noul: 0.05 },
      told_角色乙: { type: 'noul', noul: 0.05 },
      told_角色丙: { type: 'noul', noul: 0.05 },
    }
    const clean = { state_dirty: { type: 'noul', noul: 0.1 } }
    const jev = await mockJev({ answers: [
      { // 第1次：主判定 → 甲接话
        next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: {} },
        present_角色甲: { type: 'noul', noul: 0.98 },
        present_角色乙: { type: 'noul', noul: 0.9 },
        present_角色丙: { type: 'noul', noul: 0.1 },
        ...knowsAll, ...toldLow, ...clean,
      },
      { // 第2次：甲回复的合并判定 → 接力乙
        ...knowsAll, ...toldLow, ...clean,
        next_speaker: { type: 'choice', choice: '角色乙', confidence: 0.85, probabilities: {} },
      },
      { // 第3次：乙回复的合并判定 → 用户（本轮结束）
        ...knowsAll, ...toldLow, ...clean,
        next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
      },
    ] })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST, statusRecord: true })
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    const events: Array<{ type: string; picked?: string }> = []
    for await (const ev of session.speak('你们谁来说两句')) {
      if (ev.type === 'route') events.push({ type: 'route', picked: ev.picked })
      else if (ev.type === 'reply') events.push({ type: 'reply' })
    }
    const routeEvents = events.filter(e => e.type === 'route')
    const replyEvents = events.filter(e => e.type === 'reply')
    assert.equal(routeEvents.length, 2, '接力应产生两个 route 事件（甲、乙）')
    assert.equal(routeEvents[1]?.picked, '角色乙', '接力判给乙')
    assert.equal(replyEvents.length, 2, '甲、乙各回复一次，然后交还用户')
    assert.equal(jev.hits.length, 3, 'Jev 调用：1 主判定 + 2 合并判定')
    assert.equal(ds.hits.filter(h => h.kind === 'bookkeep').length, 0, '全程无状态变化：记账门控把 DeepSeek 记账省到零')
    ds.server.close(); jev.server.close()
  }

  // ── 4c) 循环上限已取消 + 衰减跨发言叠加：接力无硬上限，靠持续衰减最终把发言权判回用户。
  //         甲0.64 时再次发言 → 下一次判定压 0（衰减不推进）→ 再下一次 0.64×0.8=0.512（不重置）；
  //         正是 0.512×0.23 < 你 0.12 让链在第 5 条回复后判回用户——若实现错误地"发言即重置"，
  //         甲会是 0.8×0.23=0.184 > 0.12 继续说第 6 条，本钉即红。
  {
    const ds = await mockDeepseek({ streamText: '（继续说）……' })
    const base = {
      present_角色甲: { type: 'noul', noul: 0.98 },
      present_角色乙: { type: 'noul', noul: 0.9 },
      present_角色丙: { type: 'noul', noul: 0.9 },
      knows_角色甲: { type: 'noul', noul: 0.9 },
      knows_角色乙: { type: 'noul', noul: 0.9 },
      knows_角色丙: { type: 'noul', noul: 0.9 },
      told_角色甲: { type: 'noul', noul: 0.05 },
      told_角色乙: { type: 'noul', noul: 0.05 },
      told_角色丙: { type: 'noul', noul: 0.05 },
      state_dirty: { type: 'noul', noul: 0.1 },
    }
    const pick = (choice: string, probabilities: Record<string, number> = {}): Record<string, unknown> =>
      ({ next_speaker: { type: 'choice', choice, confidence: 0.9, probabilities } })
    const jev = await mockJev({ answers: [
      { ...pick('角色甲'), ...base },                                                        // 主判定 → 甲
      { ...base, ...pick('角色乙', { 角色甲: 0.5, 角色乙: 0.4, 角色丙: 0.05, 你: 0.05 }) },   // 甲刚发言压0 → 乙
      { ...base, ...pick('角色丙', { 角色乙: 0.5, 角色丙: 0.4, 角色甲: 0.05, 你: 0.05 }) },   // 乙压0；甲0.8×0.05=0.04 → 丙
      { ...base, ...pick('角色甲', { 角色丙: 0.5, 角色甲: 0.4, 角色乙: 0.05, 你: 0.05 }) },   // 丙压0；甲0.64×0.4=0.256 胜出 → 甲
      { ...base, ...pick('角色乙', { 角色甲: 0.5, 角色乙: 0.4, 你: 0.1 }) },                  // 甲二次发言压0（0.64不推进）；乙0.64×0.4=0.256 → 乙
      { ...base, ...pick('角色甲', { 角色乙: 0.5, 角色甲: 0.23, 你: 0.12 }) },                // 乙压0；甲累计0.512×0.23≈0.118 < 你0.12 → 你
    ] })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST, statusRecord: true })
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    const events: Array<{ type: string; text?: string; picked?: string }> = []
    for await (const ev of session.speak('开始')) {
      if (ev.type === 'route') events.push({ type: 'route', picked: ev.picked })
      else if (ev.type === 'reply') events.push({ type: 'reply' })
      else if (ev.type === 'info') events.push({ type: 'info', text: ev.text })
    }
    const replyCount = events.filter(e => e.type === 'reply').length
    assert.equal(replyCount, 5, `无上限且衰减叠加：链长超过旧上限（4 条）后由衰减判回用户，实得 ${replyCount}`)
    assert.ok(!events.some(e => e.type === 'info' && (e.text ?? '').includes('上限')), '上限已取消：不得再出现上限提示')
    assert.equal(jev.hits.length, 6, 'Jev 调用：1 主判定 + 每条回复 1 次合并判定（5 条回复）')
    const picks = events.filter(e => e.type === 'route').map(e => e.picked)
    assert.deepEqual(picks, ['角色甲', '角色乙', '角色丙', '角色甲', '角色乙'], `接力按累计衰减日程推进，实得 ${JSON.stringify(picks)}`)
    const judgeRaw = fsReadFileSync(join(accDir, '判定.jsonl'), 'utf8')
    assert.ok(judgeRaw.includes('"to":"你"'), '用户权重未衰减而胜出的翻转必须落判定日志')
    // 翻转行分布里甲的加权值必须 ≈0.1178（=0.64→压0不推进→0.512×0.23）：
    // 若"发言即重置"会是 0.184，若"压0那次错误推进衰减"会是 0.094——三者可区分
    assert.ok(judgeRaw.includes('"角色甲":0.11'), '压0判定不得推进衰减：分布里甲必须是累计 0.512 加权后的值')
    ds.server.close(); jev.server.close()
  }

  // ── 4d) 额外记忆（转告→二段判定→逐字移植）：命中移植、堆在账本末尾、无缺失轮不再触发二段
  {
    const ds = await mockDeepseek({ streamText: '（测试回复·会上内容）' })
    const cast = { // 丙在第1轮缺席（不在场），第2轮进场后被转告
      present_角色甲: { type: 'noul', noul: 0.98 },
      present_角色乙: { type: 'noul', noul: 0.9 },
      knows_角色甲: { type: 'noul', noul: 0.9 },
      knows_角色乙: { type: 'noul', noul: 0.9 },
    }
    const jev = await mockJev({ answers: [
      { // T1 主判定：甲乙在场，丙缺席且感知不到
        next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: {} },
        ...cast,
        present_角色丙: { type: 'noul', noul: 0.05 },
        knows_角色丙: { type: 'noul', noul: 0.05 },
        told_角色甲: { type: 'noul', noul: 0.05 },
        told_角色乙: { type: 'noul', noul: 0.05 },
        told_角色丙: { type: 'noul', noul: 0.05 },
        state_dirty: { type: 'noul', noul: 0.1 },
      },
      { // T1 甲回复合并判定 → 用户
        knows_角色乙: { type: 'noul', noul: 0.9 },
        knows_角色丙: { type: 'noul', noul: 0.05 },
        told_角色乙: { type: 'noul', noul: 0.05 },
        told_角色丙: { type: 'noul', noul: 0.05 },
        state_dirty: { type: 'noul', noul: 0.1 },
        next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
      },
      { // T2 主判定：丙已进场；用户发言在向丙转告第1轮的事
        next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: {} },
        ...cast,
        present_角色丙: { type: 'noul', noul: 0.95 },
        knows_角色丙: { type: 'noul', noul: 0.9 },
        told_角色甲: { type: 'noul', noul: 0.05 },
        told_角色乙: { type: 'noul', noul: 0.05 },
        told_角色丙: { type: 'noul', noul: 0.95 },
        state_dirty: { type: 'noul', noul: 0.1 },
      },
      { // T2 二段：丙缺失的第1轮 → 命中
        round_1: { type: 'noul', noul: 0.9 },
      },
      { // T2 甲回复合并判定 → 用户
        knows_角色乙: { type: 'noul', noul: 0.9 },
        knows_角色丙: { type: 'noul', noul: 0.9 },
        told_角色乙: { type: 'noul', noul: 0.05 },
        told_角色丙: { type: 'noul', noul: 0.05 },
        state_dirty: { type: 'noul', noul: 0.1 },
        next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
      },
      { // T3 主判定：又"转告"一遍（丙已无缺失轮）
        next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: {} },
        ...cast,
        present_角色丙: { type: 'noul', noul: 0.95 },
        knows_角色丙: { type: 'noul', noul: 0.9 },
        told_角色甲: { type: 'noul', noul: 0.05 },
        told_角色乙: { type: 'noul', noul: 0.05 },
        told_角色丙: { type: 'noul', noul: 0.95 },
        state_dirty: { type: 'noul', noul: 0.1 },
      },
      { // T3 甲回复合并判定 → 用户
        knows_角色乙: { type: 'noul', noul: 0.9 },
        knows_角色丙: { type: 'noul', noul: 0.9 },
        told_角色乙: { type: 'noul', noul: 0.05 },
        told_角色丙: { type: 'noul', noul: 0.05 },
        state_dirty: { type: 'noul', noul: 0.1 },
        next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
      },
    ] })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST, statusRecord: true })
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    session.setScene({ present: ['角色甲', '角色乙'], remote: [], overhear: [] }, '测试初始：丙缺席')
    const t1: string[] = []
    for await (const ev of session.speak('（测试发言·开会）')) {
      if (ev.type === 'info') t1.push(ev.text ?? '')
    }
    assert.ok(!t1.some(x => x.includes('额外得知')), '第1轮无转告：不得触发额外记忆')
    session.setScene({ present: ['角色甲', '角色乙', '角色丙'], remote: [], overhear: [] }, '丙进场')
    const t2: string[] = []
    for await (const ev of session.speak('（测试发言·转告开会的事）')) {
      if (ev.type === 'info') t2.push(ev.text ?? '')
    }
    assert.ok(t2.some(x => x.includes('额外得知') && x.includes('丙')), '转告触发：必须出现额外记忆移植提示')
    assert.ok(fsReadFileSync(join(accDir, '判定.jsonl'), 'utf8').includes('"phase":"额外记忆判定"'), '额外记忆判定必须落判定日志')
    const memLines = (n: string): Array<{ source: string; mid?: number; round: number; text: string }> => {
      const raw = fsReadFileSync(join(accDir, '角色', n, '记忆.jsonl'), 'utf8').trim()
      return raw === '' ? [] : (JSON.parse('[' + raw.split(String.fromCharCode(10)).filter(l => l !== '').join(',') + ']') as Array<{ source: string; mid?: number; round: number; text: string }>)
    }
    const bing = memLines('角色丙')
    const extra = bing.filter(e => e.source === '额外得知')
    assert.equal(extra.length, 2, '第1轮的两条消息都移植给丙')
    assert.deepEqual(extra.map(e => e.mid).sort(), [1, 2], '额外条目带原 mid')
    assert.deepEqual(extra.map(e => e.round), [1, 1], '保留原轮号')
    assert.ok(extra.every(e => /：.+$/.test(e.text) && !e.text.startsWith('（额外')), '条目 = 说话人前缀 + 逐字原文')
    // 堆在账本末尾：移植时额外条目按原消息顺序追加在他已有条目之后；
    // 本轮结束时甲回复又以亲历正常续后（移植只保证"插入即末尾"，不冻结账本尾部）
    assert.ok(bing[0] !== undefined && bing[0].source === '亲历' && bing[0].mid === 3)
    assert.deepEqual(bing.slice(1, 3).map(e => e.mid), [1, 2], '移植时刻：额外条目按原消息顺序紧跟其后')
    assert.ok(bing[3] !== undefined && bing[3].source === '亲历' && bing[3].mid === 4, '本轮回复的亲历条目继续正常追加')
    assert.equal(memLines('角色甲').filter(e => e.source === '额外得知').length, 0, '未被转告者不得获得额外条目')
    assert.equal(memLines('角色乙').filter(e => e.source === '额外得知').length, 0, '未被转告者不得获得额外条目')
    const extraLedgerRows = session.store.allLines.filter(l => l.type === 'ledger' && (l as { character?: string }).character === '角色丙' && ((l as { content?: string }).content ?? '').includes('额外得知'))
    assert.equal(extraLedgerRows.length, 2, '每条额外条目都有 ledger 行（唯一事实源）')
    // T3：再转告一次——丙已无缺失轮，二段判定不得再触发（幂等）
    for await (const ev of session.speak('（测试发言·重复转告）')) void ev
    assert.equal(jev.hits.length, 7, 'Jev 调用：T1/T2/T3 各 1 主判定 + T2/T3 各 1 合并判定 + T2 恰 1 次二段')
    assert.equal(memLines('角色丙').filter(e => e.source === '额外得知').length, 2, '重复转告不重复移植（按 mid 幂等）')
    ds.server.close(); jev.server.close()
  }

  // ── 4e) 现场所见：位置判定把丙带进当前场景 → 后台生成现状快照注入；
  //         接力判到进场者发言 → speakAs 组装前必须等注入完成（先看见，再发言）
  {
    const ds = await mockDeepseek({
      scene: '（（测试现状描述。））',
      streamText: '（测试回复）',
    })
    const lowTold = {
      told_角色甲: { type: 'noul', noul: 0.05 },
      told_角色乙: { type: 'noul', noul: 0.05 },
      told_角色丙: { type: 'noul', noul: 0.05 },
    }
    const clean = { state_dirty: { type: 'noul', noul: 0.1 } }
    const jev = await mockJev({ answers: [
      { // 第1次：主判定 → 甲接话；位置判定把丙带进当前场景；丙对进场前的消息不知情
        next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: {} },
        scene_change: { type: 'choice', choice: '未移动', confidence: 0.9, probabilities: {} },
        location_角色甲: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} },
        location_角色乙: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} },
        location_角色丙: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} },  // 丙进场
        knows_角色甲: { type: 'noul', noul: 0.9 },
        knows_角色乙: { type: 'noul', noul: 0.9 },
        knows_角色丙: { type: 'noul', noul: 0.05 },   // 进场前的消息他看不到（快照在落位前写定）
        ...lowTold, ...clean,
      },
      { // 第2次：甲回复的合并判定 → 接力判给丙（刚进场者！）
        knows_角色乙: { type: 'noul', noul: 0.9 },
        knows_角色丙: { type: 'noul', noul: 0.9 },    // 现在他在场了，听得见
        ...lowTold, ...clean,
        next_speaker: { type: 'choice', choice: '角色丙', confidence: 0.9, probabilities: {} },
      },
      { // 第3次：丙回复的合并判定 → 用户
        knows_角色甲: { type: 'noul', noul: 0.9 },
        knows_角色乙: { type: 'noul', noul: 0.9 },
        ...lowTold, ...clean,
        next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
      },
    ] })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST, statusRecord: true })
    createScene(accDir, '场景一', '（测试描述一）')
    createScene(accDir, '场景二', '（测试描述二）')
    writeFileSync(join(accDir, '群设定.yaml'), "era: （测试时代）\nworld: （测试世界）\ntone: ''\nscene: 场景一\n", 'utf8')
    // 丙的初始场景 = 场景二（其余默认场景一）
    const bingMd = join(accDir, '角色', '角色丙', '角色.md')
    writeFileSync(bingMd, fsReadFileSync(bingMd, 'utf8').replace('---\n', '---\nscene: 场景二\n'), 'utf8')
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    session.setScene({ scene: '场景一', locations: { 角色甲: '场景一', 角色乙: '场景一', 角色丙: '场景二' }, present: ['角色甲', '角色乙'], remote: [], overhear: [] }, '初始：丙在场景二')
    const events: Array<{ type: string; text?: string; picked?: string }> = []
    for await (const ev of session.speak('（推开门把丙叫了进来）都进来吧')) {
      events.push(ev.type === 'route' ? { type: 'route', picked: ev.picked } : { type: ev.type, text: 'text' in ev ? ev.text : undefined })
    }
    const types = events.map(e => e.type)
    assert.equal(events.filter(e => e.type === 'route').length, 2, '甲接话 + 接力丙')
    assert.equal(events.find(e => e.type === 'route' && e.picked === '角色丙') !== undefined, true, '接力判到进场者')
    assert.ok(events.some(e => e.type === 'info' && (e.text ?? '').includes('环顾四周')), '接力判到进场者时必须先等待现场所见注入（提示出现）')
    // 注入完成才会组装丙的发言：丙的 prompt 里必须已经带着现场快照
    const bingStream = ds.hits.filter(h => h.kind === 'stream').at(-1)
    assert.ok(bingStream !== undefined && JSON.stringify(bingStream.body).includes('测试现状描述'), '丙发言前，现场所见必须已注入其上下文')
    const memOf2 = (n: string): string => {
      try { return fsReadFileSync(join(accDir, '角色', n, '记忆.jsonl'), 'utf8') } catch { return '' }
    }
    assert.ok(memOf2('角色丙').includes('现场所见') && memOf2('角色丙').includes('测试现状描述'), '丙的记忆必须有现场所见条目')
    assert.ok(!memOf2('角色甲').includes('现场所见') && !memOf2('角色乙').includes('现场所见'), '非进场者不得获得现场所见条目')
    const userMsg2 = session.snapshot().messages.find(m => m.text.includes('都进来吧'))
    const vis = userMsg2?.visible_to === 'all' ? [] : userMsg2?.visible_to ?? []
    assert.ok(!vis.includes('角色丙'), '进场前的消息不在丙的 visible_to（快照先于场景修正写定）')
    assert.ok(fsReadFileSync(join(accDir, '判定.jsonl'), 'utf8').includes('"phase":"现场所见"'), '现场所见必须落判定日志')
    ds.server.close(); jev.server.close()
  }

  // ── 4g) 事件补全：回归者入场 → 事件发现 + 各参与者限知视角分别注入；首次进场不触发发现
  {
    const ds = await mockDeepseek({
      scene: '（屋里灯光昏黄。）',
      offstory: [{ summary: '乙和丙替甲办妥了一件托付', participants: ['角色甲', '角色乙'] }],
      povMap: {
        角色甲: '你离场期间，乙和丙替你办妥了那件托付。',
        角色乙: '你按约定替甲办妥了那件托付。',
      },
      streamText: '（测试回复）',
    })
    const jev = await mockJev({ fail: true }) // 事件补全不依赖 Jev：让 Jev 挂掉以证独立
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: [...TEST_CAST, { dir: '角色丁', name: '角色丁', personality: '（测试设定：配合）', appearance: '（测试外观）', relationships: '（测试关系）' }], statusRecord: true })
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    // 造离场窗口：甲先在场 → 离场（窗口内有乙丙照顾猫的对话）
    session.setScene({ present: ['角色甲', '角色乙', '角色丙'], remote: [], overhear: [] }, 'r1')
    session.store.append('user', '你', '（测试发言·托付）', 'all')
    session.setScene({ present: ['角色乙', '角色丙'], remote: [], overhear: [] }, '甲离场')
    session.store.append('user', '你', '（测试发言·履约）', 'all')
    // 甲回归（手动修正路径）→ 入场包：现场所见 + 事件补全
    session.setScene({ present: ['角色甲', '角色乙', '角色丙'], remote: [], overhear: [] }, '甲回归')
    session.maybeSnapshotEntrants({ present: ['角色乙', '角色丙'], remote: [], overhear: [] }, '测试进场')
    const memOf2 = (n: string): string => {
      try { return fsReadFileSync(join(accDir, '角色', n, '记忆.jsonl'), 'utf8') } catch { return '' }
    }
    for (let i = 0; i < 80; i++) {
      if (memOf2('角色甲').includes('离场经历') && memOf2('角色乙').includes('离场经历')) break
      await new Promise(r => setTimeout(r, 250))
    }
    assert.ok(memOf2('角色甲').includes('离场经历') && memOf2('角色甲').includes('替你办妥'), '回归者甲获得甲视角的离场经历')
    assert.ok(memOf2('角色乙').includes('离场经历') && memOf2('角色乙').includes('替甲办妥'), '未入场的参与者乙同样获得乙视角的离场经历')
    assert.ok(memOf2('角色甲').includes('现场所见'), '回归者同时拿到现场所见')
    assert.ok(!memOf2('角色丙').includes('离场经历'), '非参与者丙不得获得离场经历')
    const offHits = ds.hits.filter(h => h.kind === 'offstory')
    assert.equal(offHits.length, 1, '事件发现恰一次（同轮进场者合并）')
    assert.ok(JSON.stringify(offHits[0]?.body).includes('（测试发言·履约）'), '发现调用必须带离场窗口对话')
    const povHits = ds.hits.filter(h => h.kind === 'pov')
    assert.equal(povHits.length, 2, '每个（事件×参与者）各渲染一次')
    // 首次进场（丁，无离场史）→ 不触发事件发现，只拿现场所见
    session.setScene({ present: ['角色甲', '角色乙', '角色丙', '角色丁'], remote: [], overhear: [] }, '丁首次进场')
    session.maybeSnapshotEntrants({ present: ['角色甲', '角色乙', '角色丙'], remote: [], overhear: [] }, '丁首进')
    for (let i = 0; i < 80; i++) {
      if (memOf2('角色丁').includes('现场所见')) break
      await new Promise(r => setTimeout(r, 250))
    }
    assert.ok(memOf2('角色丁').includes('现场所见'), '首次进场者拿现场所见')
    assert.equal(ds.hits.filter(h => h.kind === 'offstory').length, 1, '首次进场不触发事件发现（无离场窗口）')
    assert.ok(!memOf2('角色丁').includes('离场经历'), '首次进场者不获得离场经历')
    ds.server.close(); jev.server.close()
  }

  // ── 4h) 接力累计衰减（纯代码）：刚发言者概率硬性压 0——Jev 原始选甲、分布 甲0.5 仍被压成 0
  //         → 翻转到乙（留痕，带被压 0 的完整分布）
  {
    const ds = await mockDeepseek({ streamText: '（继续）嗯。' })
    const lowNoise = {
      told_角色甲: { type: 'noul', noul: 0.05 },
      told_角色乙: { type: 'noul', noul: 0.05 },
      told_角色丙: { type: 'noul', noul: 0.05 },
      state_dirty: { type: 'noul', noul: 0.1 },
    }
    const knowsAll = {
      knows_角色甲: { type: 'noul', noul: 0.9 },
      knows_角色乙: { type: 'noul', noul: 0.9 },
      knows_角色丙: { type: 'noul', noul: 0.9 },
    }
    const jev = await mockJev({ answers: [
      { // 主判定 → 甲
        next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: { 角色甲: 0.9, 角色乙: 0.08, 角色丙: 0.02 } },
        present_角色甲: { type: 'noul', noul: 0.98 },
        present_角色乙: { type: 'noul', noul: 0.9 },
        present_角色丙: { type: 'noul', noul: 0.9 },
        ...knowsAll, ...lowNoise,
      },
      { // 甲回复 → 判定1（甲刚发言，权重压 0）：原始选甲@0.9，分布 甲0.5/乙0.45 → 翻转到乙
        ...knowsAll, ...lowNoise,
        next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: { 角色甲: 0.5, 角色乙: 0.45, 你: 0.05 } },
      },
      { // 乙回复 → 判定2 → 用户（本轮结束）
        ...knowsAll, ...lowNoise,
        next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
      },
    ] })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST, statusRecord: true })
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    session.setScene({ present: ['角色甲', '角色乙', '角色丙'], remote: [], overhear: [] }, '测试')
    const routes: string[] = []
    for await (const ev of session.speak('开始')) {
      if (ev.type === 'route') routes.push(ev.picked)
    }
    assert.deepEqual(routes, ['角色甲', '角色乙'], `刚发言者压0后必须翻转，实得 ${JSON.stringify(routes)}`)
    const judgeRaw = fsReadFileSync(join(accDir, '判定.jsonl'), 'utf8')
    assert.ok(judgeRaw.includes('"phase":"接力加权"') && judgeRaw.includes('"from":"角色甲"') && judgeRaw.includes('"to":"角色乙"'), '压0翻转必须落判定日志')
    assert.ok(judgeRaw.includes('"角色甲":0'), '刚发言者的概率必须在分布里被压成 0')
    ds.server.close(); jev.server.close()
  }

  // ── 4h-2) 刚发言者硬阻断：分布缺失时 Jev 仍点名刚发言的乙 → 不可能连续发言，发言权交还用户
  {
    const ds = await mockDeepseek({ streamText: '（接话）嗯。' })
    const knowsAB = {
      knows_角色甲: { type: 'noul', noul: 0.9 },
      knows_角色乙: { type: 'noul', noul: 0.9 },
      knows_角色丙: { type: 'noul', noul: 0.05 },
    }
    const toldLow = {
      told_角色甲: { type: 'noul', noul: 0.05 },
      told_角色乙: { type: 'noul', noul: 0.05 },
      told_角色丙: { type: 'noul', noul: 0.05 },
    }
    const clean = { state_dirty: { type: 'noul', noul: 0.1 } }
    const jev = await mockJev({ answers: [
      { // 主判定 → 甲（乙在场，丙缺席）
        next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: {} },
        present_角色甲: { type: 'noul', noul: 0.98 },
        present_角色乙: { type: 'noul', noul: 0.9 },
        present_角色丙: { type: 'noul', noul: 0.05 },
        ...knowsAB, ...toldLow, ...clean,
      },
      { // 甲回复 → 判定1（甲刚发言压0）→ 乙
        ...knowsAB, ...toldLow, ...clean,
        next_speaker: { type: 'choice', choice: '角色乙', confidence: 0.9, probabilities: {} },
      },
      { // 乙回复 → 判定2：分布缺失，Jev 仍点名刚发言的乙 → 压0硬阻断交还用户
        ...knowsAB, ...toldLow, ...clean,
        next_speaker: { type: 'choice', choice: '角色乙', confidence: 0.9, probabilities: {} },
      },
    ] })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST, statusRecord: true })
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    session.setScene({ present: ['角色甲', '角色乙'], remote: [], overhear: [] }, '测试初始')
    const routes: string[] = []
    let replyCount = 0
    let sawCap = false
    for await (const ev of session.speak('开始')) {
      if (ev.type === 'route') routes.push(ev.picked)
      else if (ev.type === 'reply') replyCount++
      else if (ev.type === 'info' && ev.text !== undefined && ev.text.includes('上限')) sawCap = true
    }
    assert.deepEqual(routes, ['角色甲', '角色乙'], '接力到乙后再点名刚发言的乙必须被阻断')
    assert.equal(replyCount, 2, '甲、乙各回复一次后交还用户')
    assert.equal(sawCap, false, '硬阻断不是上限：不得出现上限提示')
    const judgeRaw = fsReadFileSync(join(accDir, '判定.jsonl'), 'utf8')
    assert.ok(judgeRaw.includes('"phase":"接力加权"') && judgeRaw.includes('不可能连续发言'), '硬阻断必须落判定日志（带压0说明）')
    assert.equal(jev.hits.length, 3, 'Jev 调用：1 主判定 + 2 合并判定')
    ds.server.close(); jev.server.close()
  }

  // ── 4h-3) 全零分布：分布里只剩刚发言的乙（被压成 0）→ 不改判、硬阻断交还用户
  {
    const ds = await mockDeepseek({ streamText: '（接话）嗯。' })
    const knowsAB = {
      knows_角色甲: { type: 'noul', noul: 0.9 },
      knows_角色乙: { type: 'noul', noul: 0.9 },
      knows_角色丙: { type: 'noul', noul: 0.05 },
    }
    const toldLow = {
      told_角色甲: { type: 'noul', noul: 0.05 },
      told_角色乙: { type: 'noul', noul: 0.05 },
      told_角色丙: { type: 'noul', noul: 0.05 },
    }
    const clean = { state_dirty: { type: 'noul', noul: 0.1 } }
    const jev = await mockJev({ answers: [
      { // 主判定 → 甲
        next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: {} },
        present_角色甲: { type: 'noul', noul: 0.98 },
        present_角色乙: { type: 'noul', noul: 0.9 },
        present_角色丙: { type: 'noul', noul: 0.05 },
        ...knowsAB, ...toldLow, ...clean,
      },
      { // 甲回复 → 判定1（甲刚发言压0）→ 乙
        ...knowsAB, ...toldLow, ...clean,
        next_speaker: { type: 'choice', choice: '角色乙', confidence: 0.9, probabilities: {} },
      },
      { // 乙回复 → 判定2：分布里只有刚发言的乙（压成 0）→ 全零不改判 → 硬阻断交还用户
        ...knowsAB, ...toldLow, ...clean,
        next_speaker: { type: 'choice', choice: '角色乙', confidence: 0.9, probabilities: { 角色乙: 0.5 } },
      },
    ] })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST, statusRecord: true })
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    session.setScene({ present: ['角色甲', '角色乙'], remote: [], overhear: [] }, '测试初始')
    const routes: string[] = []
    let replyCount = 0
    for await (const ev of session.speak('开始')) {
      if (ev.type === 'route') routes.push(ev.picked)
      else if (ev.type === 'reply') replyCount++
    }
    assert.deepEqual(routes, ['角色甲', '角色乙'], '全零分布不得再判给任何角色')
    assert.equal(replyCount, 2, '甲、乙各回复一次后交还用户')
    const judgeRaw = fsReadFileSync(join(accDir, '判定.jsonl'), 'utf8')
    assert.ok(judgeRaw.includes('"dist":{"角色乙":0}') && judgeRaw.includes('不可能连续发言'), '全零分布与硬阻断必须留痕')
    ds.server.close(); jev.server.close()
  }

  // ── 4i) 客观注入（平面群）：knows_/told_ 不问（感知判定范畴不适用）；受众=现场记录
  //         （通道接入/单向感知不收）；msg 行带 objective 标记；移植来源=客观（逐字+mid，
  //         活账本跟随改写）；其余管线照旧（路由/回复/接力照常）
  {
    const ds = await mockDeepseek({ streamText: '（甲点头）嗯。' })
    const jev = await mockJev({ answers: [
      { // 主判定：仍问 next_speaker / perceive_ / state_dirty；knows_/told_ 缺席
        next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: {} },
        perceive_角色丙: { type: 'noul', noul: 0.9 },
        interact_角色丙: { type: 'noul', noul: 0.9 },
        mode_角色丙: { type: 'choice', choice: '语音', confidence: 0.9, probabilities: {} },
        perceive_角色丁: { type: 'noul', noul: 0.9 },
        interact_角色丁: { type: 'noul', noul: 0.1 },
        mode_角色丁: { type: 'choice', choice: '语音', confidence: 0.9, probabilities: {} },
        state_dirty: { type: 'noul', noul: 0.9 },
      },
      { // 甲回复的合并判定：回复是普通消息，知情/转告/接力照常
        knows_角色乙: { type: 'noul', noul: 0.9 },
        knows_角色丙: { type: 'noul', noul: 0.9 },
        knows_角色丁: { type: 'noul', noul: 0.9 },
        told_角色乙: { type: 'noul', noul: 0.05 },
        told_角色丙: { type: 'noul', noul: 0.05 },
        told_角色丁: { type: 'noul', noul: 0.05 },
        state_dirty: { type: 'noul', noul: 0.1 },
        next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
      },
    ] })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: [...TEST_CAST, { dir: '角色丁', name: '角色丁', personality: '（测试设定：配合）', appearance: '（测试外观）', relationships: '（测试关系）' }], statusRecord: true })
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    session.setScene({ present: ['角色甲', '角色乙'], remote: [{ character: '角色丙', perceive: '语音', note: '（测试通道）' }], overhear: [{ character: '角色丁', perceive: '语音', note: '（测试途径）' }] }, '测试初始')
    const events: Array<{ type: string }> = []
    for await (const ev of session.speak('（一晃，半年过去了。）', undefined, true)) {
      events.push({ type: ev.type })
    }
    const asked = Object.keys((jev.hits[0]?.body as { questions: Record<string, unknown> }).questions)
    assert.ok(asked.includes('next_speaker') && asked.includes('state_dirty'), '客观注入仍问路由与状态门')
    assert.ok(!asked.some(k => k.startsWith('knows_') || k.startsWith('told_')), '客观注入不问知情/转告（感知判定范畴不适用）')
    const askedAfterReply = Object.keys((jev.hits[1]?.body as { questions: Record<string, unknown> }).questions)
    assert.ok(askedAfterReply.some(k => k.startsWith('knows_')), '角色回复仍走知情判定')
    const objMsg = session.snapshot().messages.find(m => m.objective === true)
    assert.ok(objMsg !== undefined, '客观注入的消息行必须带 objective 标记')
    const vis = objMsg.visible_to === 'all' ? [] : objMsg.visible_to
    assert.deepEqual([...vis].sort(), ['角色甲', '角色乙'].sort(), '受众=现场记录（接入/单向感知层不收）')
    const memLines3 = (n: string): Array<{ source: string; mid?: number; text: string }> => {
      const raw = fsReadFileSync(join(accDir, '角色', n, '记忆.jsonl'), 'utf8').trim()
      return raw === '' ? [] : (JSON.parse('[' + raw.split(String.fromCharCode(10)).filter(l => l !== '').join(',') + ']') as Array<{ source: string; mid?: number; text: string }>)
    }
    const jiaObj = memLines3('角色甲').filter(e => e.source === '客观')
    assert.equal(jiaObj.length, 1, '现场者获得客观条目')
    assert.equal(jiaObj[0]?.mid, objMsg.id, '客观条目带 mid')
    assert.ok(jiaObj[0]?.text.includes('半年过去了'), '客观条目=逐字原文+说话人标识')
    assert.equal(memLines3('角色丙').filter(e => e.source === '客观').length, 0, '通道接入者不收客观注入')
    assert.equal(memLines3('角色丁').filter(e => e.source === '客观').length, 0, '单向感知者不收客观注入')
    session.editMessage(objMsg.id, '（一晃，半年过去了——镇口的老桥也塌了。）')
    const jiaAfter = memLines3('角色甲').find(e => e.source === '客观' && e.mid === objMsg.id)
    assert.ok(jiaAfter !== undefined && jiaAfter.text.includes('老桥'), '改写消息后客观条目同步改写（活账本）')
    assert.equal(events.filter(e => e.type === 'route').length, 1, '客观注入后照常路由')
    assert.equal(events.filter(e => e.type === 'reply').length, 1, '角色照常接话')
    ds.server.close(); jev.server.close()
  }

  // ── 4j) 状态记录开关（群设定，默认关）：state_dirty 不问、脏回复不记账；群设定改为 true 后
  //         （引擎每轮重读，开关即时生效）状态门恢复判定、记账照旧
  {
    const ds = await mockDeepseek({
      bookkeep: { 状态账本: [{ character: '角色甲', 心理状态: '紧张' }] },
      streamText: '（测试回复）',
    })
    const jev = await mockJev({ answers: [
      { // 主判定（关）：state_dirty 不问（mock 里的答案被忽略）
        next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: {} },
        state_dirty: { type: 'noul', noul: 0.9 },
      },
      { // 甲回复的合并判定（关）：state_dirty 不问
        knows_角色乙: { type: 'noul', noul: 0.9 },
        knows_角色丙: { type: 'noul', noul: 0.9 },
        told_角色乙: { type: 'noul', noul: 0.05 },
        told_角色丙: { type: 'noul', noul: 0.05 },
        state_dirty: { type: 'noul', noul: 0.9 },
        next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
      },
      { // 开关打开后的主判定：用户发言本身不脏
        next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: {} },
        state_dirty: { type: 'noul', noul: 0.1 },
      },
      { // 开关打开后的合并判定：回复脏 → 恰一次记账
        knows_角色乙: { type: 'noul', noul: 0.9 },
        knows_角色丙: { type: 'noul', noul: 0.9 },
        told_角色乙: { type: 'noul', noul: 0.05 },
        told_角色丙: { type: 'noul', noul: 0.05 },
        state_dirty: { type: 'noul', noul: 0.95 },
        next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
      },
    ] })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST }) // 不传 statusRecord = 默认关
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    assert.equal(session.snapshot().statusRecord, false, '缺省（群设定无论/false）= 关')
    for await (const ev of session.speak('（吓人的事发生了）')) void ev
    const askedOff = Object.keys((jev.hits[0]?.body as { questions: Record<string, unknown> }).questions)
    assert.ok(!askedOff.includes('state_dirty'), '状态记录关：主判定不问状态门')
    assert.equal(ds.hits.filter(h => h.kind === 'bookkeep').length, 0, '状态记录关：脏回复也不记账')
    const streamOff = ds.hits.filter(h => h.kind === 'stream')
    assert.ok(streamOff.length > 0 && streamOff.every(h => !JSON.stringify(h.body).includes('你当前的状态账本')), '状态记录关：角色生成请求体不含状态账本（角色连读都不读）')
    writeFileSync(join(accDir, '群设定.yaml'), "era: （测试用时代背景）\nworld: |\n  （测试用世界观）\ntone: \nstatusRecord: true\n", 'utf8')
    for await (const ev of session.speak('（又发生了可怕的事）')) void ev
    const askedOn = Object.keys((jev.hits[2]?.body as { questions: Record<string, unknown> }).questions)
    assert.ok(askedOn.includes('state_dirty'), '状态记录开：状态门恢复判定')
    const streamOn = ds.hits.filter(h => h.kind === 'stream').slice(streamOff.length)
    assert.ok(streamOn.length > 0 && streamOn.every(h => JSON.stringify(h.body).includes('你当前的状态账本')), '状态记录开：角色生成请求体含状态账本')
    for (let i = 0; i < 40; i++) {
      if (fsReadFileSync(join(accDir, '角色', '角色甲', '状态.yaml'), 'utf8').includes('紧张')) break
      await new Promise(r => setTimeout(r, 250))
    }
    assert.equal(ds.hits.filter(h => h.kind === 'bookkeep').length, 1, '状态记录开：回复脏 → 恰一次记账')
    assert.ok(fsReadFileSync(join(accDir, '角色', '角色甲', '状态.yaml'), 'utf8').includes('紧张'), '状态记录开：记账落盘')
    ds.server.close(); jev.server.close()
  }

  // ── 4k) 状态记录关 + 回退路径：总管的状态账本被丢弃（无 ledger 事件、状态.yaml 不变），路由照常；
  //        开关打开后同一形状的账本更新照常即时应用（回退路径是同步落盘，无需轮询）
  {
    const ds = await mockDeepseek({
      route: { next_speaker: '角色甲', reason: '测试', 状态账本: [{ character: '角色甲', 心理状态: '愉快' }] },
      streamText: '（测试回复）',
    })
    const jev = await mockJev({ fail: true })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST }) // 默认关
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    const events: Array<{ type: string }> = []
    for await (const ev of session.speak('（测试发言）')) {
      events.push({ type: ev.type })
    }
    assert.ok(!events.some(e => e.type === 'ledger'), '状态记录关：回退总管的账本更新不产生 ledger 事件')
    assert.ok(!fsReadFileSync(join(accDir, '角色', '角色甲', '状态.yaml'), 'utf8').includes('愉快'), '状态记录关：状态.yaml 不被写入')
    assert.equal(ds.hits.filter(h => h.kind === 'route').length, 1, '状态记录关：路由照常')
    writeFileSync(join(accDir, '群设定.yaml'), "era: （测试用时代背景）\nworld: |\n  （测试用世界观）\ntone: \nstatusRecord: true\n", 'utf8')
    for await (const ev of session.speak('（再一句）')) void ev
    assert.ok(fsReadFileSync(join(accDir, '角色', '角色甲', '状态.yaml'), 'utf8').includes('愉快'), '状态记录开：回退总管的账本更新照常即时应用')
    ds.server.close(); jev.server.close()
  }

  // ── 4l) 思维链记录：reasoning_content 逐字落盘（按消息 id 键控，只给人看）；不进记忆、
  //         不进该轮任何模型提示词；删除消息时记录一并清除
  {
    const ds = await mockDeepseek({ reasoning: '（思维链标记：先亮明身份，再劝阻对方。）', streamText: '（甲亮明身份劝阻）不要去。' })
    const jev = await mockJev({ answers: [
      { // 主判定 → 甲
        next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: {} },
        present_角色甲: { type: 'noul', noul: 0.98 },
        present_角色乙: { type: 'noul', noul: 0.9 },
        present_角色丙: { type: 'noul', noul: 0.9 },
        knows_角色甲: { type: 'noul', noul: 0.9 },
        knows_角色乙: { type: 'noul', noul: 0.9 },
        knows_角色丙: { type: 'noul', noul: 0.9 },
        told_角色甲: { type: 'noul', noul: 0.05 },
        told_角色乙: { type: 'noul', noul: 0.05 },
        told_角色丙: { type: 'noul', noul: 0.05 },
        state_dirty: { type: 'noul', noul: 0.1 },
      },
      { // 甲回复的合并判定 → 用户
        knows_角色乙: { type: 'noul', noul: 0.9 },
        knows_角色丙: { type: 'noul', noul: 0.9 },
        told_角色乙: { type: 'noul', noul: 0.05 },
        told_角色丙: { type: 'noul', noul: 0.05 },
        state_dirty: { type: 'noul', noul: 0.1 },
        next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
      },
    ] })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST, statusRecord: true })
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    for await (const ev of session.speak('别去那里')) void ev
    const reply = session.snapshot().messages.find(m => m.role === 'character')
    assert.ok(reply !== undefined, '角色回复已落盘')
    const raw = fsReadFileSync(join(accDir, '思维链.jsonl'), 'utf8')
    const line = JSON.parse(raw.trim().split(String.fromCharCode(10)).find(l => l !== '')!) as { id: number; name: string; thinking: string }
    assert.equal(line.id, reply.id, '思维链按消息 id 键控')
    assert.equal(line.name, '角色甲', '思维链记录发言者')
    assert.ok(line.thinking.includes('思维链标记'), 'reasoning_content 逐字落盘')
    const memOf4l = (n: string): string => {
      try { return fsReadFileSync(join(accDir, '角色', n, '记忆.jsonl'), 'utf8') } catch { return '' }
    }
    assert.ok(!memOf4l('角色甲').includes('思维链标记') && !memOf4l('角色乙').includes('思维链标记'), '思维链不进任何记忆')
    assert.ok(ds.hits.every(h => !JSON.stringify(h.body).includes('思维链标记')), '思维链不进该轮任何模型提示词')
    const { getThinking } = await import('../src/group/thinking.ts')
    assert.ok(getThinking(accDir, reply.id)?.includes('思维链标记'), '按消息 id 可取回思维链')
    session.deleteMessage(reply.id)
    assert.ok(!fsReadFileSync(join(accDir, '思维链.jsonl'), 'utf8').includes('思维链标记'), '删除消息后思维链记录一并清除')
    ds.server.close(); jev.server.close()
  }

  // ── 5) 端到端：Jev 故障 → 整轮回退 deepseek 完整总管
  {
    const ds = await mockDeepseek({
      route: { next_speaker: '角色甲', reason: '回退路由', 状态账本: [{ character: '角色甲', 心理状态: '如常' }] },
      streamText: '（甲点头）嗯。',
    })
    const jev = await mockJev({ fail: true })
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    const events: Array<{ type: string; text?: string; picked?: string; fallback?: boolean }> = []
    for await (const ev of session.speak('再聊一句')) {
      events.push(ev.type === 'route' ? { type: 'route', picked: ev.picked, fallback: ev.fallback } : { type: ev.type, text: 'text' in ev ? ev.text : undefined })
    }
    const route = events.find(e => e.type === 'route')
    assert.equal(route?.picked, '角色甲', '回退路径的总管路由必须生效')
    assert.equal(route?.fallback, false)
    assert.ok(events.some(e => e.type === 'ledger' && (e.text ?? '').includes('心理状态')), '回退路径的记账随总管结果应用')
    assert.equal(ds.hits.filter(h => h.kind === 'route').length, 1, '回退时应恰好一次 deepseek 路由调用')
    assert.ok(!JSON.stringify(ds.hits.find(h => h.kind === 'route')?.body ?? {}).includes(RULES_MARKER),
      '回退总管的提示词不得包含用户规则')
    assert.equal(ds.hits.filter(h => h.kind === 'bookkeep').length, 0, '回退路径不再单独记账')
    assert.equal(jev.hits.length, 2, 'Jev 仍被尝试（主判定 + 合并判定，均失败走保底）')
    ds.server.close(); jev.server.close()
  }

  // ── 5b) 端到端（地图群）：路由置信塌掉但位置判定明确 → 路由走完整总管，Jev 的位置落定照常生效（不连坐）
  {
    const ds = await mockDeepseek({
      route: { next_speaker: '角色甲', reason: '回退路由' },
      streamText: '（甲点头）嗯。',
    })
    const jev = await mockJev({ answers: {
      next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.15, probabilities: {} },  // 路由置信塌掉
      scene_change: { type: 'choice', choice: '未移动', confidence: 0.9, probabilities: {} },
      location_角色甲: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} },
      location_角色乙: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} },
      location_角色丙: { type: 'choice', choice: '场景一', confidence: 0.9, probabilities: {} },  // 丙进场
      knows_角色甲: { type: 'noul', noul: 0.9 },
      knows_角色乙: { type: 'noul', noul: 0.9 },
      knows_角色丙: { type: 'noul', noul: 0.9 },
    } })
    createScene(accDir, '场景一', '（测试描述一）')
    createScene(accDir, '场景二', '（测试描述二）')
    writeFileSync(join(accDir, '群设定.yaml'), "era: （测试时代）\nworld: （测试世界）\ntone: ''\nscene: 场景一\n", 'utf8')
    writeTestSettings(ds.port, jev.port)
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    session.setScene({ scene: '场景一', locations: { 角色甲: '场景一', 角色乙: '场景一', 角色丙: '场景二' }, present: ['角色甲', '角色乙'], remote: [], overhear: [] }, '初始：丙在场景二')
    const events: Array<{ type: string; picked?: string; text?: string }> = []
    for await (const ev of session.speak('（丙轻轻推门走了进来）')) {
      events.push(ev.type === 'route' ? { type: 'route', picked: ev.picked } : { type: ev.type, text: 'text' in ev ? ev.text : undefined })
    }
    const route = events.find(e => e.type === 'route')
    assert.equal(route?.picked, '角色甲', '路由由回退的完整总管决定')
    assert.ok(session.snapshot().present.includes('角色丙'), 'Jev 的位置落定必须照常生效（不与路由连坐）')
    assert.equal(ds.hits.filter(h => h.kind === 'route').length, 1, '回退路径恰一次完整总管路由')
    ds.server.close(); jev.server.close()
  }

  // ── 6) 未配置 routerId → 完全走旧路径（兼容保证）
  {
    const ds = await mockDeepseek({
      route: { next_speaker: '角色甲', reason: '旧路径' },
      streamText: '（甲）在。',
    })
    writeFileSync(settingsFile, `activeId: pd\nrouterId: ''\nproviders:\n  - { id: pd, name: deepseek-mock, baseUrl: 'http://127.0.0.1:${ds.port}', apiKey: fake, model: fake-model, reasoningEffort: off }\n`, 'utf8')
    const { GroupSession } = await import('../src/group/engine.ts')
    const session = GroupSession.open(accName)
    for await (const ev of session.speak('最后一句')) void ev
    assert.equal(ds.hits.filter(h => h.kind === 'route').length, 1, '未配置快路径时走完整总管')
    assert.equal(ds.hits.filter(h => h.kind === 'stream').length, 1)
    ds.server.close()
  }

  console.log('快/慢双路径自检通过：Jev命中/位置判定(场景choice)/链接推导/知情名单(原文移植，含偷听者)/低置信与名单外→路由回退但位置知情不连坐(留痕) · 合并判定(知情+总门+转告+接力一次调用) · 额外记忆(一段触发/二段逐轮/逐字移植/带mid幂等/堆在末尾) · 记账门控(无变化零调用/回复脏恰一次) · 记账员无名册权(越权丢弃) · 规则注入边界(仅角色生成上下文；主判定/合并判定/记账/回退总管不含) · 客观注入(不问知情/转告/受众=现场记录/接入与单向感知不收/客观条目带mid活账本/管线照旧) · 状态记录开关(默认关：不问state_dirty/脏回复不记账/回退总管账本丢弃；群设定改true即时生效：判定与记账恢复) · 思维链(reasoning逐字落盘按mid键控/不进记忆不进任何提示词/删除消息一并清除) · 现场所见(进场检测/发言前等待) · 事件补全(离场锚点纯代码/发现一次合并/事件×参与者限知视角分别注入/首次进场不触发) · 接力判定（判给用户即结束/刚发言压0不可能连续发言/无硬上限） · 接力累计衰减（每判定乘0.8重新发言不重置/衰减最终判回用户/翻转与阻断留痕） · 回退=完整总管 · 未配置=完全兼容')
} finally {
  rmSync(accDir, { recursive: true, force: true })
  if (hadSettings) writeFileSync(settingsFile, backup ?? '', 'utf8')
  else if (existsSync(settingsFile)) rmSync(settingsFile, { force: true })
  rmSync(settingsFile + '.selfcheck-bak', { force: true })
  if (hadRules) writeFileSync(rulesFile, rulesBackup ?? '', 'utf8')
  else if (existsSync(rulesFile)) rmSync(rulesFile, { force: true })
  if (hadRulesList) writeFileSync(rulesListFile, rulesListBackup ?? '', 'utf8')
  else if (existsSync(rulesListFile)) rmSync(rulesListFile, { force: true })
}
