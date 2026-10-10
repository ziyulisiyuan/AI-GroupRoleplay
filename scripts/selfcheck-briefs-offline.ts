/**
 * 离场管线（任务书 §2/§3/§4）离线自检：本地 mock Jev + mock 对话模型，无需 API key。
 * 覆盖（对应 .local-plans 任务书 §10 的 P1–P15）：
 *  P2/P4/P4a 任务书落盘字段、windowKeys 只取 participants 里本次离开者的窗口、一次分离一次成文
 *  P2b 离场起点按名字链归一（presence 行保留历史名）
 *  P3  判定达阈值才写；无 Jev 快路径不写（窗口留待下次）
 *  P5/P6 请求体块完整、行首标注（剧情原文/客观注入）
 *  P7  ≤100 全给 / >100 最新 50 + 每本往前 20（纯函数按 §5.6 算例核对）
 *  P8  同一节点只给一段上下文
 *  P9/P10 写错人丢弃、一条记忆只进对应角色
 *  P11/P12 收账：点名变"已收"、未点名留桌上；已收不再进任何请求体
 *  前置条件：回来者必须被某本在用任务书锚定才触发补全（未匹配不调用；改名沿名字链归一）
 *  P13 状态记录关闭：回退总管工具 schema 不带账本字段、任务书描绘的档案不带账本
 *  P15 锚定以参与名单为准：未点名者不得记忆/窗口；点名为空 → 零记忆
 * 另：手动调整不触发离场管线（moveCurrentScene）；回来者开口前先等记忆落盘；剧情场景列按消息角色判定（用户改称呼 / 平面群 / 改名角色）。
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { createScene } from '../src/group/scene.ts'
import { createGroup, saveGroupSettings, updateCharacter } from '../src/group/scaffold.ts'
import { GroupSession, dialogueLinesOf } from '../src/group/engine.ts'
import { completionDialogue, loadBriefs, resolveBriefParticipants, resolveWindowKeys, sceneEnterMid, windowKey, type Brief } from '../src/group/briefs.ts'
import { StoryStore, type MsgLine, type StoryLine } from '../src/store.ts'

const accName = '_selfcheck-briefs'
const accDir = join(config.groupsDir, accName)
const nrName = '_selfcheck-briefs-nr'
const nrDir = join(config.groupsDir, nrName)
const settingsFile = join(config.root, 'settings.yaml')
const hadSettings = existsSync(settingsFile)
const backup = hadSettings ? readFileSync(settingsFile, 'utf8') : undefined
writeFileSync(settingsFile + '.selfcheck-bak', backup ?? '', 'utf8')
const S1 = '场景一'
const S2 = '场景二'
const sleep = async (ms: number): Promise<void> => { await new Promise(r => setTimeout(r, ms)) }

function writeSettings(dsPort: number, jevPort: number | undefined): void {
  writeFileSync(settingsFile, jevPort === undefined
    ? `activeId: pd\nrouterId: ''\nproviders:\n  - { id: pd, name: ds-mock, baseUrl: 'http://127.0.0.1:${dsPort}', apiKey: fake, model: fake-model, reasoningEffort: off }\n`
    : `activeId: pd\nrouterId: pj\nproviders:\n  - { id: pd, name: ds-mock, baseUrl: 'http://127.0.0.1:${dsPort}', apiKey: fake, model: fake-model, reasoningEffort: off }\n  - { id: pj, name: jev-mock, baseUrl: 'http://127.0.0.1:${jevPort}', apiKey: fake, model: jev-test, reasoningEffort: off }\n`, 'utf8')
}

function makeChar(groupDir: string, name: string, scene: string): void {
  const dir = join(groupDir, '角色', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '角色.md'), `---\nname: ${name}\nappearance: |\n  （测试外观）\nscene: ${scene}\n---\n\n（测试背景）\n`, 'utf8')
  writeFileSync(join(dir, '性格.md'), '# 性格\n\n（测试设定：有话直说）\n', 'utf8')
  writeFileSync(join(dir, '人物关系.md'), '# 人物关系\n\n（测试关系）\n', 'utf8')
  writeFileSync(join(dir, '状态.yaml'), '生理状态: （测试：健康）\n', 'utf8')
  writeFileSync(join(dir, '记忆.jsonl'), '', 'utf8')
}

const memOf = (dir: string, name: string): string => {
  try { return readFileSync(join(dir, '角色', name, '记忆.jsonl'), 'utf8') } catch { return '' }
}
const judgeLogOf = (dir: string): string => {
  try { return readFileSync(join(dir, '判定.jsonl'), 'utf8') } catch { return '' }
}

async function mockJev(script: { route: Array<Record<string, unknown>>; gate?: Array<number | 'fail'> }): Promise<{ server: Server; port: number; hits: Array<Record<string, unknown>>; gates: Array<Record<string, unknown>> }> {
  const hits: Array<Record<string, unknown>> = []
  const gates: Array<Record<string, unknown>> = []
  let ri = 0
  let gi = 0
  const server = createServer((req, res) => {
    let buf = ''
    req.on('data', (c: Buffer) => { buf += c })
    req.on('end', () => {
      const body = JSON.parse(buf) as Record<string, unknown>
      const q = (body.questions ?? {}) as Record<string, unknown>
      res.setHeader('content-type', 'application/json')
      if (Object.prototype.hasOwnProperty.call(q, 'briefs')) {
        gates.push({ url: req.url, body })
        const g = script.gate?.[Math.min(gi, script.gate.length - 1)] ?? 0.9
        gi++
        if (g === 'fail') { res.statusCode = 500; res.end(); return }
        res.end(JSON.stringify({ model: 'jev-test', answers: { briefs: { type: 'noul', noul: g } } }))
        return
      }
      hits.push({ url: req.url, body })
      // 路由判定（第二段）：只问 next_speaker 一道题——不消耗脚本条目，用同一轮第一段的答案作答
      const isRoutingOnly = Object.keys(q).length === 1 && Object.prototype.hasOwnProperty.call(q, 'next_speaker')
      const a = script.route[Math.max(0, Math.min(isRoutingOnly ? ri - 1 : ri, script.route.length - 1))]
      if (!isRoutingOnly) ri++
      res.end(JSON.stringify({ model: 'jev-test', answers: a ?? {} }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, port, hits, gates }
}

interface ModelHit { kind: 'route' | 'bookkeep' | 'scene' | 'brief' | 'memory' | 'stream'; body: Record<string, unknown> }

async function mockModel(script: {
  routeArgs?: Record<string, unknown>
  briefs?: Array<Record<string, unknown>>
  memories?: Array<{ character: string; text: string }>
  consume?: 'all' | 'none'
  streamText?: (body: Record<string, unknown>) => string
  scene?: string
}): Promise<{ server: Server; port: number; hits: ModelHit[] }> {
  const hits: ModelHit[] = []
  const server = createServer((req, res) => {
    let buf = ''
    req.on('data', (c: Buffer) => { buf += c })
    req.on('end', () => {
      const body = JSON.parse(buf) as Record<string, unknown>
      const tools = JSON.stringify(body.tools ?? [])
      const reply = (name: string, args: string): void => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ function: { name, arguments: args } }] } }] }))
      }
      if (tools.includes('route_and_remember')) { hits.push({ kind: 'route', body }); reply('route_and_remember', JSON.stringify(script.routeArgs ?? { next_speaker: '角色甲', reason: '（测试）' })); return }
      if (tools.includes('record_round')) { hits.push({ kind: 'bookkeep', body }); reply('record_round', '{}'); return }
      if (tools.includes('record_scene')) { hits.push({ kind: 'scene', body }); reply('record_scene', JSON.stringify({ scene_summary: script.scene ?? '（测试现状描述。）' })); return }
      if (tools.includes('record_brief')) { hits.push({ kind: 'brief', body }); reply('record_brief', JSON.stringify({ briefs: script.briefs ?? [] })); return }
      if (tools.includes('write_offstory_memory')) {
        hits.push({ kind: 'memory', body })
        const ids = [...buf.matchAll(/【(b[a-z0-9]+)｜节点/g)].map(m => m[1])
        const consumed = script.consume === 'none' ? [] : ids
        reply('write_offstory_memory', JSON.stringify({ facts: ['（测试事实）'], consumedBriefs: consumed, memories: script.memories ?? [] }))
        return
      }
      hits.push({ kind: 'stream', body })
      const text = script.streamText !== undefined ? script.streamText(body) : '（测试回复）'
      res.setHeader('content-type', 'text/event-stream')
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, port, hits }
}

/** 各问题的预设答案；缺的字段按 "保持现状/低概率" 处理。 */
function mainJudge(loc: Record<string, string>, next = '角色甲'): Record<string, unknown> {
  return {
    next_speaker: { type: 'choice', choice: next, confidence: 0.9, probabilities: {} },
    scene_change: { type: 'choice', choice: '未移动', confidence: 0.9, probabilities: {} },
    location_角色甲: { type: 'choice', choice: loc['角色甲'], confidence: 0.9, probabilities: {} },
    location_角色乙: { type: 'choice', choice: loc['角色乙'], confidence: 0.9, probabilities: {} },
    location_角色丙: { type: 'choice', choice: loc['角色丙'], confidence: 0.9, probabilities: {} },
    knows_角色甲: { type: 'noul', noul: 0.9 },
    knows_角色乙: { type: 'noul', noul: 0.9 },
    knows_角色丙: { type: 'noul', noul: 0.9 },
    told_角色甲: { type: 'noul', noul: 0.05 },
    told_角色乙: { type: 'noul', noul: 0.05 },
    told_角色丙: { type: 'noul', noul: 0.05 },
    state_dirty: { type: 'noul', noul: 0.1 },
  }
}
function replyJudge(next: string, others: string[]): Record<string, unknown> {
  const a: Record<string, unknown> = { state_dirty: { type: 'noul', noul: 0.1 }, next_speaker: { type: 'choice', choice: next, confidence: 0.9, probabilities: {} } }
  for (const n of others) { a[`knows_${n}`] = { type: 'noul', noul: 0.9 }; a[`told_${n}`] = { type: 'noul', noul: 0.05 } }
  return a
}

const mkMsg = (id: number): MsgLine => ({ type: 'msg', id, role: 'user', name: '你', text: `（测试第${id}句）`, round: 1, visible_to: 'all', ts: new Date(0).toISOString() })
const mkBrief = (id: string, nodeId: string, judgeMid: number): Brief => ({ id, nodeId, judgeMid, createdTs: '', status: '在用', windowKeys: [], title: '（测试事件）', place: '（测试地点）', participants: ['角色甲'], facts: ['（测试事实）'], sequence: [], perceives: [] })
const mkPresence = (scene: string): StoryLine => ({ type: 'presence', scene, present: [], reason: '（测试）', ts: new Date(0).toISOString() } as StoryLine)

try {
  // ── A) 纯函数：窗口标识 / enterMid / 上下文截取（§5.2/§5.3/§5.6/§3.2.1）
  {
    assert.equal(windowKey('角色甲', 30), '角色甲|30')
    const lines: StoryLine[] = [
      { ...mkMsg(1), type: 'msg' },
      mkPresence(S1),
      { ...mkMsg(2), type: 'msg' },
      mkPresence(S2),
      { ...mkMsg(3), type: 'msg' },
      { ...mkMsg(4), type: 'msg' },
      mkPresence(S2),
    ]
    assert.equal(sceneEnterMid(lines, S2), 2, 'enterMid = 当前场景这段连续运行第一行之前最近的消息号')
    assert.equal(sceneEnterMid(lines, S1), 1, '旧场景段仍可计算')
    assert.equal(sceneEnterMid(lines, '场景三'), 0, '找不到该场景 → 0')

    // 编号化兼容：token（旧显示名/历史名）→ 编号；外号/翻不出的直接丢弃
    const stale = [{ ...mkBrief('bRename', 'nRename', 30), participants: ['角色甲甲', '角色乙', '红哥'] }]
    const resolveId = (n: string): string | undefined => (n === '角色甲甲' ? '角色甲' : n === '角色乙' ? '角色乙' : undefined)
    const resolvedB = resolveBriefParticipants(stale, resolveId)
    assert.deepEqual(resolvedB[0]?.participants, ['角色甲', '角色乙'], '参与名单按编号归一：旧名→编号、外号丢弃')
    assert.deepEqual([...resolveWindowKeys(['角色甲甲|30', '角色乙|60', '红哥|90'], resolveId)].sort(), ['角色甲|30', '角色乙|60'].sort(), '窗口键按编号归一：旧名→编号、翻不出丢弃')

    const msgs = Array.from({ length: 200 }, (_, i) => mkMsg(i + 1))
    const briefs = [mkBrief('bX', 'nX', 30), mkBrief('bY', 'nY', 60), mkBrief('bX2', 'nX', 30)]
    const ctx = completionDialogue(msgs, [31], briefs, 200)
    assert.equal(ctx.returnedRange.length, 50, '>100：回来范围给最新 50 条')
    assert.equal(ctx.returnedRange[0].id, 151)
    const segX = ctx.segments.find(s => s.nodeId === 'nX')
    assert.deepEqual(segX?.messages.map(m => m.id), Array.from({ length: 21 }, (_, i) => 10 + i), '§5.6 算例：X 段 = 第 10–30 句')
    assert.equal(ctx.segments.filter(s => s.nodeId === 'nX').length, 1, '同节点只给一段（P8）')
    assert.deepEqual(ctx.segments.find(s => s.nodeId === 'nY')?.messages.map(m => m.id), Array.from({ length: 21 }, (_, i) => 40 + i), '§5.6 算例：Y 段 = 第 40–60 句')
    const small = msgs.slice(0, 80)
    const ctx2 = completionDialogue(small, [10], briefs, 80)
    assert.equal(ctx2.returnedRange[0].id, 10)
    assert.equal(ctx2.returnedRange[ctx2.returnedRange.length - 1].id, 80, '≤100：回来范围全给')
    // 改名不丢离场起点：presence 行保留历史名时，absenceStartId 必须按名字链归一到当前名
    const renameDir = mkdtempSync(join(tmpdir(), 'briefs-rename-'))
    try {
      const rs = StoryStore.open(renameDir, 'g')
      rs.appendPresence(['角色甲'], '初始')
      const mid = rs.append('user', '你', '（测试第 1 句）').id
      rs.appendRename('角色甲', '角色乙') // 只改显示名；presence 行仍是旧名
      rs.appendPresence([], '离开')        // 第一条新名 presence 行 = 已经不在场
      assert.equal(rs.absenceStartId('角色乙'), mid, '离场起点按名字链归一：当前名与历史名查到同一起点')
      assert.equal(rs.absenceStartId('角色甲'), mid, '历史名查询归一到同一窗口')
    } finally {
      rmSync(renameDir, { recursive: true, force: true })
    }
    // 剧情场景列：按消息角色判定用户/角色；地图群用实际场景，平面群用现场/不在场；名字链归一
    const nameOfProbe = (n: string): string => (n === '角色丁' ? '角色戊' : n)
    const rowMap: StoryLine = { type: 'presence', scene: S1, locations: { '角色丁': S1 }, present: ['角色丁'], reason: '（测试）', ts: new Date(0).toISOString() }
    const rowFlat: StoryLine = { type: 'presence', present: ['角色甲'], reason: '（测试）', ts: new Date(0).toISOString() }
    const msgUserOld: MsgLine = { ...mkMsg(1), role: 'user', name: '旧称呼' }
    const msgCharOld: MsgLine = { ...mkMsg(2), role: 'character', name: '角色戊' }
    const msgUserFlat: MsgLine = { ...mkMsg(3), role: 'user', name: '你' }
    const msgCharFlat: MsgLine = { ...mkMsg(4), role: 'character', name: '角色甲' }
    const msgCharOut: MsgLine = { ...mkMsg(5), role: 'character', name: '角色乙' }
    assert.ok(dialogueLinesOf([msgUserOld], [rowMap, msgUserOld], nameOfProbe).includes('｜旧称呼｜场景：场景一｜'), '地图群：用户改称呼前的消息按实际场景标注')
    assert.ok(dialogueLinesOf([msgCharOld], [rowMap, msgCharOld], nameOfProbe).includes('｜角色戊｜场景：场景一｜'), '地图群：改名角色按历史位置键解析')
    assert.ok(dialogueLinesOf([msgUserFlat], [rowFlat, msgUserFlat], nameOfProbe).includes('｜你｜场景：现场｜'), '平面群：用户消息的场景列是现场')
    assert.ok(dialogueLinesOf([msgCharFlat], [rowFlat, msgCharFlat], nameOfProbe).includes('｜角色甲｜场景：现场｜'), '平面群：在场角色是现场')
    assert.ok(dialogueLinesOf([msgCharOut], [rowFlat, msgCharOut], nameOfProbe).includes('｜角色乙｜场景：不在场｜'), '平面群：不在场角色是不在场')
    console.log('A) 纯函数/存储：窗口标识 / enterMid / 上下文截取 / 剧情场景列 / 改名后离场起点归一（含 §5.6 算例、同节点去重）通过')
  }
  // ── B) 端到端：分离写任务书（§2/§3）→ 回来收账写记忆（§4）；含等待/丢弃/收账/已收不可见
  {
    rmSync(accDir, { recursive: true, force: true })
    createGroup(accDir, { era: '（测试时代）', world: '（测试世界）', tone: '', scene: S1, statusRecord: true, pinned: false }, [
      { name: S1, description: '（测试描述一）' },
      { name: S2, description: '（测试描述二）' },
    ])
    makeChar(accDir, '角色甲', S1)
    makeChar(accDir, '角色乙', S1)
    makeChar(accDir, '角色丙', S2)

    const ds = await mockModel({
      briefs: [{
        title: '（测试事件）', place: S1, participants: ['角色甲', '角色乙'],
        facts: ['（测试事实）'], sequence: [], perceives: [{ character: '角色乙', saw: ['（测试所见）'] }],
      }],
      memories: [
        { character: '角色乙', text: '（测试记忆·乙）' },
        { character: '角色甲', text: '（测试记忆·甲）' },
        { character: '角色丙', text: '（测试记忆·丙）' },
      ],
      streamText: body => JSON.stringify(body).includes('你扮演「角色乙」') ? '（测试回复·乙）' : '（测试回复·甲）',
    })
    const jev = await mockJev({
      route: [
        mainJudge({ 角色甲: S1, 角色乙: '其他', 角色丙: S2 }),
        replyJudge('你', ['角色乙', '角色丙']),
        mainJudge({ 角色甲: S1, 角色乙: S1, 角色丙: S2 }),
        replyJudge('角色乙', ['角色乙', '角色丙']),
        replyJudge('你', ['角色甲', '角色丙']),
        mainJudge({ 角色甲: S1, 角色乙: S1, 角色丙: S2 }, '角色甲'),
        mainJudge({ 角色甲: S1, 角色乙: S1, 角色丙: S2 }, '角色丙'),
      ],
      gate: [0.9, 0.9, 0.9],
    })
    writeSettings(ds.port, jev.port)
    const session = GroupSession.open(accName)

    // 第 1 轮：对话里乙离开（剧情驱动）→ 判定通过 → 写任务书；没有回来者 → 暂不写记忆
    for await (const ev of session.speak('（测试发言·送别）')) void ev
    const userMsg1 = session.snapshot().messages.find(m => m.text.includes('送别'))
    let briefs = loadBriefs(accDir)
    for (let i = 0; i < 40 && briefs.length === 0; i++) { await sleep(250); briefs = loadBriefs(accDir) }
    assert.equal(briefs.length, 1, '分离 → 一次判定一次成文（P1/P4a）')
    const b1 = briefs[0]!
    assert.equal(b1.status, '在用', '新任务书在用')
    assert.equal(b1.judgeMid, userMsg1?.id, 'judgeMid = 判定发起时的消息号（之后）')
    assert.equal(b1.title, '（测试事件）')
    assert.deepEqual(b1.participants, ['角色甲', '角色乙'])
    assert.deepEqual(b1.windowKeys, [`角色乙|${userMsg1?.id}`], 'windowKeys 只取 participants 里本次离开者的窗口（P2）')
    assert.ok(b1.nodeId.startsWith('n') && b1.id.startsWith('b'), '编号格式')
    assert.ok(!memOf(accDir, '角色乙').includes('离场经历'), '分离时不写离场记忆（等回来才写）')
    const briefHit = ds.hits.filter(h => h.kind === 'brief')[0]
    assert.ok(briefHit !== undefined, '任务书描绘调用存在')
    const briefBody = JSON.stringify(briefHit.body)
    for (const block of ['[场景地图]', '[当前场景]', '[角色档案]', '[位置]', '[剧情原文]', '[窗口]']) {
      assert.ok(briefBody.includes(block), `描绘请求体必须带 ${block}（P5）`)
    }
    assert.ok(briefBody.includes('[剧情原文] #') && briefBody.includes('第1轮'), '剧情原文逐条带行标与轮次（P5/P6）')
    assert.ok(briefBody.includes('状态账本'), '状态记录开：档案带状态账本')
    assert.ok(briefBody.includes('编号：角色甲｜名字：角色甲'), '档案按编号渲染（编号=角色目录名）')
    const enumIds = ((briefHit.body as any).tools?.[0]?.function?.parameters?.properties?.briefs?.items?.properties?.participants?.items?.enum ?? []) as string[]
    assert.deepEqual([...enumIds].sort(), ['角色甲', '角色乙', '角色丙'].sort(), '参与名单只能从角色编号枚举中选')
    assert.ok(briefBody.includes('ALGORITHM OffStoryBriefGeneration') && briefBody.includes('准确优先') && briefBody.includes('FORBIDDEN') && briefBody.includes('[客观注入]'), '任务书提示词：伪代码形态/准确优先/禁令/客观注入语义（P5）')
    assert.equal(((jev.gates[0]?.body as any)?.questions?.briefs?.type), 'noul', '任务书判定是 noul 题（P3）')
    assert.ok(JSON.stringify(jev.gates[0]?.body).includes('[窗口]'), '判定请求体带窗口块')
    const gateBody = JSON.stringify(jev.gates[0]?.body)
    assert.ok(gateBody.includes('[剧情原文]') && gateBody.includes('送别'), '判定必须携带与描绘同量的剧情窗口（P3）')
    assert.ok(gateBody.includes('任务书') && gateBody.includes('留底'), '判定提示词必须说明任务书定义与 1/0 判据（P3）')

    // 第 2 轮：乙回来 → 补离场经历（先等落盘再开口）；写错人（丙）被丢弃
    const events2: Array<{ type: string; text?: string; name?: string }> = []
    for await (const ev of session.speak('（测试发言·归来）')) {
      events2.push({ type: ev.type, ...('text' in ev ? { text: ev.text } : {}), ...('name' in ev ? { name: ev.name } : {}) })
    }
    briefs = loadBriefs(accDir)
    const b1after = briefs.find(b => b.id === b1.id)!
    assert.equal(b1after.status, '已收', '被点名的任务书收进后台（P11）')
    assert.ok(b1after.usedBy !== undefined && b1after.usedTs !== undefined, 'usedTs/usedBy 落盘')
    assert.ok(memOf(accDir, '角色乙').includes('（测试记忆·乙）'), '回来者乙的记忆落盘（P10）')
    assert.ok(memOf(accDir, '角色甲').includes('（测试记忆·甲）'), '未回来的参与者甲同样写（§4.2）')
    assert.ok(!memOf(accDir, '角色丙').includes('（测试记忆·丙）'), '不在参与名单里的记忆整条丢弃（P9）')
    const memHit = ds.hits.filter(h => h.kind === 'memory').at(-1)
    assert.ok(JSON.stringify(memHit?.body).includes(b1.id), '补全请求体带在用的任务书')
    assert.ok(JSON.stringify(memHit?.body).includes('ALGORITHM OffStoryMemoryGeneration') && JSON.stringify(memHit?.body).includes('视角模型') && JSON.stringify(memHit?.body).includes('FORBIDDEN'), '离场记忆提示词：伪代码形态/视角模型/禁令（P5）')
    const logB = judgeLogOf(accDir)
    for (const phase of ['任务书判定', '任务书描绘', '离场补全']) assert.ok(logB.includes(`"phase":"${phase}"`), `判定日志含 ${phase}（§9）`)
    assert.ok(/"dropped":1/.test(logB), '写错人计数进日志（P9）')
    assert.ok(events2.some(e => (e.text ?? '').includes('回忆离场期间的事')), '回来者开口前先等离场管线（提示出现）')
    assert.ok(events2.some(e => (e.text ?? '').includes('离场经历已记入记忆')), '落盘后有 info 事件（§4.5）')
    const bingStream = ds.hits.filter(h => h.kind === 'stream' && JSON.stringify(h.body).includes('你扮演「角色乙」')).at(-1)
    assert.ok(JSON.stringify(bingStream?.body).includes('（测试记忆·乙）'), '乙开口时记忆已在上下文里（先想起再开口）')

    // 第 3 轮：⊘ 去场景二（甲/乙留守=分离、丙重逢）→ 写新任务书；但丙不在任何在用任务书里，
    //         匹配不上 → 不触发离场补全（新任务书留在桌上）
    const memCallsBefore = ds.hits.filter(h => h.kind === 'memory').length
    for await (const ev of session.speak('（测试发言·换场）', S2)) void ev
    briefs = loadBriefs(accDir)
    for (let i = 0; i < 40 && briefs.filter(b => b.status === '在用').length < 1; i++) { await sleep(250); briefs = loadBriefs(accDir) }
    for (let i = 0; i < 40 && !judgeLogOf(accDir).includes('未被任何在用任务书锚定'); i++) await sleep(250)
    assert.equal(briefs.filter(b => b.status === '已收').length, 1, '旧任务书保持已收')
    assert.equal(briefs.filter(b => b.status === '在用').length, 1, '新任务书留在桌上（回来者未匹配，不触发补全）')
    assert.equal(ds.hits.filter(h => h.kind === 'memory').length, memCallsBefore, '匹配不上：不调用离场补全（前置条件）')
    assert.ok(judgeLogOf(accDir).includes('未被任何在用任务书锚定'), '未匹配必须落判定日志')
    // 第 4 轮：⊘ 回场景一（丙留守=分离、甲/乙重逢）→ 甲/乙匹配上在用任务书 → 触发补全并收账
    for await (const ev of session.speak('（测试发言·回场）', S1)) void ev
    for (let i = 0; i < 40 && ds.hits.filter(h => h.kind === 'memory').length < memCallsBefore + 1; i++) await sleep(250)
    briefs = loadBriefs(accDir)
    assert.equal(briefs.filter(b => b.status === '已收').length, 3, '回来者匹配上：在用任务书都被收走（连同早先那张共 3 张已收）')
    const memHit2 = ds.hits.filter(h => h.kind === 'memory').at(-1)
    assert.ok(memHit2 !== undefined, '第四轮的离场补全调用存在')
    assert.ok(!JSON.stringify(memHit2.body).includes(b1.id), '已收任务书不再进入请求体（P12）')

    // 手动调整：不触发离场管线（不产生新任务书）
    const beforeCount = loadBriefs(accDir).length
    session.moveCurrentScene(S1)
    await sleep(300)
    assert.equal(loadBriefs(accDir).length, beforeCount, '手动切场景不产生任务书')
    ds.server.close(); jev.server.close()
    console.log('B) 端到端：分离写任务书 → 回来收账写记忆（等待/丢弃/收账/已收不可见）通过')
  }

  // ── C) 门控与无快路径：不写任务书 / 工具 schema 与角色档案按状态记录开关裁剪（P13）
  {
    rmSync(nrDir, { recursive: true, force: true })
    createGroup(nrDir, { era: '（测试时代）', world: '（测试世界）', tone: '', scene: S1, statusRecord: false, pinned: false }, [
      { name: S1, description: '（测试描述一）' },
      { name: S2, description: '（测试描述二）' },
    ])
    makeChar(nrDir, '角色甲', S1)
    makeChar(nrDir, '角色乙', S1)
    const dsC = await mockModel({
      routeArgs: { next_speaker: '角色甲', reason: '（测试）', presence_updates: [{ present: ['角色甲'], reason: '（测试移出）' }] },
      briefs: [{ title: '（测试事件）', place: S1, participants: ['角色甲'], facts: ['（测试事实）'], sequence: [], perceives: [] }],
      memories: [{ character: '角色甲', text: '（测试记忆·甲）' }],
      streamText: () => '（测试回复）',
    })
    writeSettings(dsC.port, undefined)
    const sC = GroupSession.open(nrName)
    for await (const ev of sC.speak('（测试发言·无快路径）')) void ev
    const routeHits1 = dsC.hits.filter(h => h.kind === 'route')
    assert.ok(routeHits1.length >= 1, '无快路径：回退总管被调用')
    assert.ok(!JSON.stringify(routeHits1[0]!.body).includes('状态账本'), '状态记录关闭：route_and_remember 工具 schema 不带状态账本（P13）')
    for (let i = 0; i < 20 && !judgeLogOf(nrDir).includes('未配置快路径'); i++) await sleep(150)
    assert.ok(judgeLogOf(nrDir).includes('未配置快路径'), '无 Jev：记日志且不写任务书（P3）')
    assert.equal(loadBriefs(nrDir).length, 0, '无快路径不写任务书')

    // 状态记录开启：同一路径的工具 schema 带上状态账本
    saveGroupSettings(nrDir, { era: '', world: '', tone: '', scene: S1, statusRecord: true, pinned: false })
    for await (const ev of sC.speak('（测试发言·开账本）')) void ev
    const routeHits2 = dsC.hits.filter(h => h.kind === 'route')
    assert.ok(JSON.stringify(routeHits2.at(-1)!.body).includes('状态账本'), '状态记录开启：schema 带状态账本')

    // 快路径开启 + 状态记录关闭：任务书描绘的档案不带账本字段
    saveGroupSettings(nrDir, { era: '', world: '', tone: '', scene: S1, statusRecord: false, pinned: false })
    const jevC = await mockJev({ route: [mainJudge({ 角色甲: '其他', 角色乙: '其他', 角色丙: '其他' })], gate: [0.9] })
    writeSettings(dsC.port, jevC.port)
    for await (const ev of sC.speak('（测试发言·描绘关账本）')) void ev
    let briefsC = loadBriefs(nrDir)
    for (let i = 0; i < 40 && briefsC.length === 0; i++) { await sleep(250); briefsC = loadBriefs(nrDir) }
    assert.equal(briefsC.length, 1, '快路径 + 判定通过 → 写任务书')
    const briefHitC = dsC.hits.filter(h => h.kind === 'brief').at(-1)
    assert.ok(briefHitC !== undefined, '描绘调用存在')
    const bodyC = JSON.stringify(briefHitC.body)
    assert.ok(bodyC.includes('[角色档案]') && bodyC.includes('性格'), '档案块存在')
    assert.ok(!bodyC.includes('状态账本'), '状态记录关闭：档案不带账本字段（P13）')
    dsC.server.close(); jevC.server.close()
    console.log('C) 门控：无快路径不写任务书；状态记录开关决定 schema/档案是否带账本 通过')
  }

  // ── D) 改名后的分离（端到端）：位置表 / 离场起点都按名字链归一，窗口键必须以编号（目录名）锚定
  {
    const rnName = '_selfcheck-briefs-rn'
    const rnDir = join(config.groupsDir, rnName)
    rmSync(rnDir, { recursive: true, force: true })
    createGroup(rnDir, { era: '（测试时代）', world: '（测试世界）', tone: '', scene: S1, statusRecord: false, pinned: false }, [
      { name: S1, description: '（测试描述一）' },
      { name: S2, description: '（测试描述二）' },
    ])
    makeChar(rnDir, '角色丁', S1)
    // presence 行写的是改名前的名字（角色丁）；改名只改显示名，目录名不变
    StoryStore.open(rnDir, rnName).appendPresence(['角色丁'], '初始', [], [], S1, { '角色丁': S1 })
    updateCharacter(rnDir, '角色丁', { name: '角色戊', appearance: '（测试外观）', background: '（测试背景）', personality: '', relationships: '' })
    // 改名后、下一次场景变更之前，先说一句（新名）：其场景列沿名字链解析到历史 presence 行
    StoryStore.open(rnDir, rnName).append('character', '角色戊', '（测试：改名后说的一句）', 'all')
    const dsD = await mockModel({
      briefs: [{
        title: '（测试事件·改名后）', place: S1, participants: ['角色丁'],
        facts: ['（测试事实）'], sequence: [], perceives: [{ character: '角色丁', saw: ['（测试所见）'] }],
      }],
      streamText: () => '（测试回复）',
    })
    const jevD = await mockJev({
      route: [{
        next_speaker: { type: 'choice', choice: '角色戊', confidence: 0.9, probabilities: {} },
        scene_change: { type: 'choice', choice: '未移动', confidence: 0.9, probabilities: {} },
        location_角色戊: { type: 'choice', choice: '其他', confidence: 0.9, probabilities: {} },
        knows_角色戊: { type: 'noul', noul: 0.9 },
        told_角色戊: { type: 'noul', noul: 0.05 },
        state_dirty: { type: 'noul', noul: 0.1 },
      }],
      gate: [0.9],
    })
    writeSettings(dsD.port, jevD.port)
    const sD = GroupSession.open(rnName)
    for await (const ev of sD.speak('（测试发言·改名后离开）')) void ev
    let briefsD = loadBriefs(rnDir)
    for (let i = 0; i < 40 && briefsD.length === 0; i++) { await sleep(250); briefsD = loadBriefs(rnDir) }
    assert.equal(briefsD.length, 1, '改名后分离产出任务书（位置表按名字链归一）')
    const bD = briefsD[0]!
    const userMsgD = sD.snapshot().messages.find(m => m.text.includes('改名后离开'))
    assert.deepEqual(bD.participants, ['角色丁'], '参与名单用编号（目录名）——显示名已改为角色戊后依然如此')
    assert.deepEqual(bD.windowKeys, [`角色丁|${userMsgD?.id}`], '窗口键以编号（目录名）锚定')
    const briefBodyD = JSON.stringify(dsD.hits.filter(h => h.kind === 'brief')[0]?.body ?? {})
    assert.ok(briefBodyD.includes('场景：场景一｜可见：all｜（测试：改名后说的一句）'), '改名后消息的场景列沿名字链解析到历史 presence 行')
    dsD.server.close(); jevD.server.close()
    rmSync(rnDir, { recursive: true, force: true })
  }

  console.log('D) 改名后分离：位置表键归一 · 窗口键以编号锚定 通过')
  console.log('离场管线自检通过（任务书）：窗口/enterMid/上下文截取 · 分离判定与描绘 · 回来者锚定前置条件 · 回来收账写记忆 · 等待与丢弃 · 已收不可见 · 门控与无快路径 · 角色编号（目录名）锚定 · 历史名/外号归一与丢弃')
} finally {
  rmSync(accDir, { recursive: true, force: true })
  rmSync(nrDir, { recursive: true, force: true })
  rmSync(join(config.groupsDir, '_selfcheck-briefs-rn'), { recursive: true, force: true })
  if (hadSettings) writeFileSync(settingsFile, backup ?? '', 'utf8')
  else if (existsSync(settingsFile)) rmSync(settingsFile, { force: true })
  rmSync(settingsFile + '.selfcheck-bak', { force: true })
}