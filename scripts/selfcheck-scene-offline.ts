/**
 * 地图机制离线自检（无需 API key；本地 mock 端点）。
 * 夹具一律中性命名（场景一/二、角色甲/乙/丙、（测试发言））——回归钉的承重部分是
 * 脚本化的 Jev 答案与对引擎状态的断言，语料内容不承载任何判定语义。
 * 1) 场景文件层：创建/列表/重名拒绝/描述可改（名称不可改不可删）/非法名拒绝。
 * 2) 建群即建图：群设定 scene + 场景文件；角色初始场景 → 引擎初始状态（同场景者现场，他者不在）。
 * 3) ⊘ 手选移动：跳过 scene_change 判定（questions 无此题）；目的地里的人直接在场并听见进门这句；
 *    同行者按 location 答案随行；一直在目的地者不入入场包。
 * 4) 判定移动：scene_change choice 命中（含置信阈值）；未命中/未移动不动。
 * 5) 对话进场：location 答案把图外角色落位当前场景（晚于快照：不在 visible_to），入场包照常注入。
 * 6) 场景全文注入角色（assembleGroup）。
 * 7) 离开者去向=其他：位置清空（图外）。
 * 8) 跨场景通话：perceive+interact 双高 → 双向接入（语音）→ 接入者可被路由接话，位置不动。
 * settings.yaml 若存在则备份、结束恢复（测试注入 routerId/activeId 指向本地 mock）。
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { createScene, listScenes, saveSceneDescription } from '../src/group/scene.ts'
import { createGroup } from '../src/group/scaffold.ts'
import { loadGroupSettings } from '../src/group/persona.ts'
import { GroupSession } from '../src/group/engine.ts'

const accName = '_selfcheck-scene'
const accDir = join(config.groupsDir, accName)
const settingsFile = join(config.root, 'settings.yaml')
const hadSettings = existsSync(settingsFile)
const backup = hadSettings ? readFileSync(settingsFile, 'utf8') : undefined
writeFileSync(settingsFile + '.selfcheck-bak', backup ?? '', 'utf8')

const S1 = '场景一'
const S2 = '场景二'

async function mockJev(script: { answers?: Record<string, unknown> | Array<Record<string, unknown>> }): Promise<{ server: Server; port: number; hits: Array<Record<string, unknown>> }> {
  const hits: Array<Record<string, unknown>> = []
  const server = createServer((req, res) => {
    let buf = ''
    req.on('data', (c: Buffer) => { buf += c })
    req.on('end', () => {
      const answers: Record<string, unknown> | undefined = Array.isArray(script.answers)
        ? script.answers[Math.min(hits.length, script.answers.length - 1)]
        : script.answers
      hits.push({ url: req.url, body: JSON.parse(buf) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ model: 'jev-test', answers: answers ?? {} }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, port, hits }
}

interface DeepseekHit { kind: 'route' | 'bookkeep' | 'scene' | 'offstory' | 'pov' | 'stream'; body: Record<string, unknown> }

async function mockDeepseek(script: { streamText?: string; scene?: string }): Promise<{ server: Server; port: number; hits: DeepseekHit[] }> {
  const hits: DeepseekHit[] = []
  const server = createServer((req, res) => {
    let buf = ''
    req.on('data', (c: Buffer) => { buf += c })
    req.on('end', () => {
      const body = JSON.parse(buf) as Record<string, unknown>
      const tools = JSON.stringify(body.tools ?? [])
      if (tools.includes('record_scene')) {
        hits.push({ kind: 'scene', body })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ function: { name: 'record_scene', arguments: JSON.stringify({ scene_summary: script.scene ?? '（测试现状描述。）' }) } }] } }] }))
        return
      }
      if (tools.includes('record_round')) {
        hits.push({ kind: 'bookkeep', body })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ function: { name: 'record_round', arguments: '{}' } }] } }] }))
        return
      }
      hits.push({ kind: 'stream', body })
      res.setHeader('content-type', 'text/event-stream')
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: script.streamText ?? '（测试回复）' } }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, port, hits }
}

const writeTestSettings = (dsPort: number, jevPort: number): void => {
  writeFileSync(settingsFile, `activeId: pd\nrouterId: pj\nproviders:\n  - { id: pd, name: deepseek-mock, baseUrl: 'http://127.0.0.1:${dsPort}', apiKey: fake, model: fake-model, reasoningEffort: off }\n  - { id: pj, name: jev-mock, baseUrl: 'http://127.0.0.1:${jevPort}', apiKey: fake, model: jev-test, reasoningEffort: off }\n`, 'utf8')
}

/** 造一个带初始场景的角色（五文件）。 */
function makeChar(groupDir: string, name: string, scene: string): void {
  const dir = join(groupDir, '角色', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '角色.md'), `---\nname: ${name}\nappearance: |\n  （测试外观）\n${scene === '' ? '' : `scene: ${scene}\n`}---\n\n（测试背景）\n`, 'utf8')
  writeFileSync(join(dir, '性格.md'), '# 性格\n\n（测试设定：有话直说）\n', 'utf8')
  writeFileSync(join(dir, '人物关系.md'), '# 人物关系\n\n（测试关系）\n', 'utf8')
  writeFileSync(join(dir, '状态.yaml'), '{}\n', 'utf8')
  writeFileSync(join(dir, '记忆.jsonl'), '', 'utf8')
}

const memOf = (name: string): string => {
  try { return readFileSync(join(accDir, '角色', name, '记忆.jsonl'), 'utf8') } catch { return '' }
}
const sleep = async (ms: number): Promise<void> => { await new Promise(r => setTimeout(r, ms)) }

try {
  // ── 1) 场景文件层
  rmSync(accDir, { recursive: true, force: true })
  mkdirSync(accDir, { recursive: true })
  createScene(accDir, S1, '（测试描述一）')
  createScene(accDir, S2, '（测试描述二）')
  assert.throws(() => createScene(accDir, S1, 'x'), /已存在/, '重名拒绝')
  assert.throws(() => createScene(accDir, 'a/b', 'x'), /非法/, '非法名拒绝')
  saveSceneDescription(accDir, S1, '（改后的测试描述）')
  assert.equal(listScenes(accDir).find(s => s.name === S1)?.description, '（改后的测试描述）', '描述可改')
  assert.equal(listScenes(accDir).find(s => s.name === S1)?.name, S1, '名称不可改')
  rmSync(accDir, { recursive: true, force: true })

  // ── 2) 建群即建图 + 初始状态
  createGroup(accDir, { era: '（测试时代）', world: '（测试世界）', tone: '', scene: S1 }, [
    { name: S1, description: '（测试描述一）' },
    { name: S2, description: '（测试描述二）' },
  ])
  assert.equal(loadGroupSettings(accDir).scene, S1, '初始当前场景落群设定')
  makeChar(accDir, '角色甲', S1)
  makeChar(accDir, '角色乙', S1)
  makeChar(accDir, '角色丙', S2)

  const ds = await mockDeepseek({ streamText: '（测试回复）', scene: '（测试现状描述。）' })
  const jev = await mockJev({ answers: [
    { // 第1轮主判定：⊘ 手选（scene_change 不应被问）；location 答案：甲随行落位场景二，乙留守场景一，丙原位
      next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: {} },
      location_角色甲: { type: 'choice', choice: S2, confidence: 0.9, probabilities: {} },
      location_角色乙: { type: 'choice', choice: S1, confidence: 0.9, probabilities: {} },
      location_角色丙: { type: 'choice', choice: S2, confidence: 0.9, probabilities: {} },
      knows_角色甲: { type: 'noul', noul: 0.95 },
      knows_角色乙: { type: 'noul', noul: 0.05 },
      knows_角色丙: { type: 'noul', noul: 0.95 },
      told_角色甲: { type: 'noul', noul: 0.05 },
      told_角色乙: { type: 'noul', noul: 0.05 },
      told_角色丙: { type: 'noul', noul: 0.05 },
      state_dirty: { type: 'noul', noul: 0.1 },
    },
    { // 甲回复的合并判定 → 用户
      knows_角色乙: { type: 'noul', noul: 0.05 },
      knows_角色丙: { type: 'noul', noul: 0.9 },
      told_角色乙: { type: 'noul', noul: 0.05 },
      told_角色丙: { type: 'noul', noul: 0.05 },
      state_dirty: { type: 'noul', noul: 0.1 },
      next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
    },
  ] })
  writeTestSettings(ds.port, jev.port)
  const session = GroupSession.open(accName)
  assert.deepEqual(session.presentNames().sort(), ['角色甲', '角色乙'].sort(), '初始：同场景者现场，丙不在')
  assert.equal(session.snapshot().scene, S1)

  const events: Array<{ type: string; text?: string; picked?: string }> = []
  for await (const ev of session.speak('（测试发言·移动）', S2)) {
    events.push(ev.type === 'route' ? { type: 'route', picked: ev.picked } : { type: ev.type, text: 'text' in ev ? ev.text : undefined })
  }
  // ⊘ 手选跳过判定：questions 里没有 scene_change，也没有 present_*
  const askedKeys = Object.keys((jev.hits[0]?.body as { questions: Record<string, unknown> }).questions)
  assert.ok(!askedKeys.includes('scene_change'), '手选时不得再问换场景判定')
  assert.ok(!askedKeys.some(k => k.startsWith('present_')), 'present 判定已删除：不得再问')
  assert.ok(askedKeys.includes('location_角色甲'), '位置判定必须问')
  assert.equal(session.snapshot().scene, S2, '手选生效：当前场景=场景二')
  assert.deepEqual(session.presentNames().sort(), ['角色甲', '角色丙'].sort(), '目的地里的人 + 随行者现场；留守的乙不在')
  const snapMsg = session.snapshot().messages.find(m => m.text === '（测试发言·移动）')
  const vis = snapMsg?.visible_to === 'all' ? [] : snapMsg?.visible_to ?? []
  assert.ok(vis.includes('角色丙') && vis.includes('角色甲'), '目的地里的人与随行者听见进门这句')
  assert.ok(!vis.includes('角色乙'), '留守原地的乙听不到')
  assert.ok(events.some(e => e.type === 'info' && (e.text ?? '').includes('手选')), '场景更新事件必须标注手选')
  // 丙一直在目的地（位置没变）→ 不入入场包；甲随行（位置变了）→ 入场包
  await sleep(1200)
  assert.ok(!memOf('角色丙').includes('现场所见'), '一直在目的地者不得获得现场所见')
  assert.ok(memOf('角色甲').includes('现场所见'), '随行者进入新场景必须获得现场所见')

  // ── 3) 判定移动回场景一（scene_change 命中）；甲丙留守（去向=场景二）；乙在场
  ds.server.close(); jev.server.close()
  const events2: Array<{ type: string; text?: string }> = []
  const ds2 = await mockDeepseek({ streamText: '（测试回复）' })
  const jev2 = await mockJev({ answers: [
    { // 主判定：scene_change 命中场景一；同行者甲留守场景二；乙在场
      next_speaker: { type: 'choice', choice: '角色乙', confidence: 0.9, probabilities: {} },
      scene_change: { type: 'choice', choice: S1, confidence: 0.9, probabilities: {} },
      location_角色甲: { type: 'choice', choice: S2, confidence: 0.9, probabilities: {} },
      location_角色乙: { type: 'choice', choice: S1, confidence: 0.9, probabilities: {} },
      location_角色丙: { type: 'choice', choice: S2, confidence: 0.9, probabilities: {} },
      knows_角色甲: { type: 'noul', noul: 0.05 },
      knows_角色乙: { type: 'noul', noul: 0.95 },
      knows_角色丙: { type: 'noul', noul: 0.05 },
      told_角色甲: { type: 'noul', noul: 0.05 },
      told_角色乙: { type: 'noul', noul: 0.05 },
      told_角色丙: { type: 'noul', noul: 0.05 },
      state_dirty: { type: 'noul', noul: 0.1 },
    },
    { // 乙回复的合并判定 → 用户
      knows_角色甲: { type: 'noul', noul: 0.05 },
      knows_角色丙: { type: 'noul', noul: 0.05 },
      told_角色甲: { type: 'noul', noul: 0.05 },
      told_角色丙: { type: 'noul', noul: 0.05 },
      state_dirty: { type: 'noul', noul: 0.1 },
      next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
    },
  ] })
  writeTestSettings(ds2.port, jev2.port)
  for await (const ev of session.speak('（测试发言·返回）')) {
    events2.push({ type: ev.type, text: 'text' in ev ? ev.text : undefined })
  }
  assert.equal(session.snapshot().scene, S1, '判定移动生效')
  assert.deepEqual(session.presentNames(), ['角色乙'], '留在场景二的甲丙不在现场')
  const backMsg = session.snapshot().messages.find(m => m.text === '（测试发言·返回）')
  const backVis = backMsg?.visible_to === 'all' ? [] : backMsg?.visible_to ?? []
  assert.deepEqual(backVis, ['角色乙'], '乙（在场景一）听见回来这句；甲丙（场景二）听不到')
  assert.deepEqual(session.snapshot().locations, { 角色甲: S2, 角色乙: S1, 角色丙: S2 }, '离开者去向必须有后台记录（presence 行的位置表）')

  // ── 4) 严苛不移动：scene_change=未移动 → 提到图外地点也不动
  jev2.hits.length = 0
  const ds3 = await mockDeepseek({ streamText: '（测试回复）' })
  const jev3 = await mockJev({ answers: {
    next_speaker: { type: 'choice', choice: '角色乙', confidence: 0.9, probabilities: {} },
    scene_change: { type: 'choice', choice: '未移动', confidence: 0.9, probabilities: {} },
    location_角色甲: { type: 'choice', choice: S2, confidence: 0.9, probabilities: {} },
    location_角色乙: { type: 'choice', choice: S1, confidence: 0.9, probabilities: {} },
    location_角色丙: { type: 'choice', choice: S2, confidence: 0.9, probabilities: {} },
    knows_角色乙: { type: 'noul', noul: 0.95 },
    told_角色乙: { type: 'noul', noul: 0.05 },
    state_dirty: { type: 'noul', noul: 0.1 },
  } })
  writeTestSettings(ds3.port, jev3.port)
  for await (const ev of session.speak('（测试发言·提及图外地点）')) void ev
  assert.equal(session.snapshot().scene, S1, '极严苛：提到未建图地点/未明确移动 = 不动')

  // ── 5) 对话进场：location 答案把丙落位当前场景 → 晚于快照（不在 visible_to）；入场包注入
  jev3.hits.length = 0
  const ds4 = await mockDeepseek({ streamText: '（测试回复）', scene: '（测试现状描述。）' })
  const jev4 = await mockJev({ answers: [
    { // 主判定：location 丙 = 场景一（对话明确召唤进场）
      next_speaker: { type: 'choice', choice: '角色丙', confidence: 0.9, probabilities: {} },
      location_角色甲: { type: 'choice', choice: S2, confidence: 0.9, probabilities: {} },
      location_角色乙: { type: 'choice', choice: S1, confidence: 0.9, probabilities: {} },
      location_角色丙: { type: 'choice', choice: S1, confidence: 0.9, probabilities: {} },
      knows_角色甲: { type: 'noul', noul: 0.05 },
      knows_角色乙: { type: 'noul', noul: 0.95 },
      knows_角色丙: { type: 'noul', noul: 0.05 },
      told_角色甲: { type: 'noul', noul: 0.05 },
      told_角色乙: { type: 'noul', noul: 0.05 },
      told_角色丙: { type: 'noul', noul: 0.05 },
      state_dirty: { type: 'noul', noul: 0.1 },
    },
    { // 丙回复的合并判定 → 用户
      knows_角色甲: { type: 'noul', noul: 0.05 },
      knows_角色乙: { type: 'noul', noul: 0.95 },
      told_角色甲: { type: 'noul', noul: 0.05 },
      told_角色乙: { type: 'noul', noul: 0.05 },
      state_dirty: { type: 'noul', noul: 0.1 },
      next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
    },
  ] })
  writeTestSettings(ds4.port, jev4.port)
  for await (const ev of session.speak('（测试发言·召唤）')) void ev
  const callMsg = session.snapshot().messages.find(m => m.text.includes('（测试发言·召唤）'))
  const callVis = callMsg?.visible_to === 'all' ? [] : callMsg?.visible_to ?? []
  assert.ok(!callVis.includes('角色丙'), '刚进场者听不到召唤这句')
  assert.ok(session.presentNames().includes('角色丙'), '对话明确进场 → 落位当前场景')
  for (let i = 0; i < 40; i++) {
    if (memOf('角色丙').includes('现场所见')) break
    await sleep(250)
  }
  assert.ok(memOf('角色丙').includes('测试现状描述'), '进场者必须先拿到现场所见再开口')
  const sceneHit = ds4.hits.filter(h => h.kind === 'scene').at(-1)
  assert.ok(sceneHit !== undefined && JSON.stringify(sceneHit.body).includes('[人员位置'), '现场所见提示词必须携带判定层的位置表')

  // ── 6) 场景全文注入角色
  const streamHit = ds4.hits.filter(h => h.kind === 'stream').at(-1)
  assert.ok(streamHit !== undefined, '必须有角色生成调用')
  const prompt = JSON.stringify(streamHit.body)
  assert.ok(prompt.includes('（测试描述一）'), '地图全文注入：场景一')
  assert.ok(prompt.includes('（测试描述二）'), '地图全文注入：场景二')
  assert.ok(prompt.includes(`当前场景：${S1}`), '当前场景标注')

  // ── 7) 离开者去向=其他：乙离开且对话没说去哪 → 位置清空（其他）；下次回场景一他不在
  const ds5 = await mockDeepseek({ streamText: '（测试回复）' })
  const jev5 = await mockJev({ answers: [
    { // 主判定：乙明确离开，去向未提及 → 其他
      next_speaker: { type: 'choice', choice: '角色丙', confidence: 0.9, probabilities: {} },
      location_角色甲: { type: 'choice', choice: S2, confidence: 0.9, probabilities: {} },
      location_角色乙: { type: 'choice', choice: '其他', confidence: 0.9, probabilities: {} },
      location_角色丙: { type: 'choice', choice: S1, confidence: 0.9, probabilities: {} },
      knows_角色乙: { type: 'noul', noul: 0.95 },
      knows_角色丙: { type: 'noul', noul: 0.95 },
      told_角色乙: { type: 'noul', noul: 0.05 },
      told_角色丙: { type: 'noul', noul: 0.05 },
      state_dirty: { type: 'noul', noul: 0.1 },
    },
    { // 丙回复的合并判定 → 用户
      knows_角色甲: { type: 'noul', noul: 0.05 },
      knows_角色乙: { type: 'noul', noul: 0.05 },
      told_角色甲: { type: 'noul', noul: 0.05 },
      told_角色乙: { type: 'noul', noul: 0.05 },
      state_dirty: { type: 'noul', noul: 0.1 },
      next_speaker: { type: 'choice', choice: '你', confidence: 0.9, probabilities: {} },
    },
  ] })
  writeTestSettings(ds5.port, jev5.port)
  for await (const ev of session.speak('（测试发言·离开）')) void ev
  assert.ok(!session.presentNames().includes('角色乙'), '明确离开 → 不在现场')
  const stored = (session as unknown as { scene: { locations?: Record<string, string> } }).scene
  assert.ok(!Object.keys(stored.locations ?? {}).includes('角色乙'), '去向=其他 → 位置清空（图外）')
  assert.ok(!Object.keys(session.snapshot().locations).includes('角色乙'), '快照位置表同源：乙已清位')

  ds2.server.close(); jev2.server.close()
  ds3.server.close(); jev3.server.close()
  ds4.server.close(); jev4.server.close()
  ds5.server.close(); jev5.server.close()

  // 测试 8 前置：众人散去——甲/丙在场景二，乙图外，用户独自在场景一
  session.setScene({ scene: S1, locations: { 角色甲: S2, 角色丙: S2 }, present: [], remote: [], overhear: [] }, '测试前置：众人散去')

  // ── 8) 跨场景通话：用户（场景一）与丙（场景二）通话 → perceive+interact 双高推导出双向接入
  //         （语音）→ 丙进入可发言名单并能被路由接话；位置不动（通话不传送人）；
  //         通话内容经 knows 判定移植进丙的记忆；呼叫那句经 since 锚点能被丙听到。
  {
    const ds6 = await mockDeepseek({ streamText: '（测试回复·接入）' })
    const jev6 = await mockJev({ answers: {
      next_speaker: { type: 'choice', choice: '角色丙', confidence: 0.9, probabilities: {} },
      scene_change: { type: 'choice', choice: '未移动', confidence: 0.9, probabilities: {} },
      location_角色甲: { type: 'choice', choice: S2, confidence: 0.9, probabilities: {} },
      location_角色乙: { type: 'choice', choice: '其他', confidence: 0.9, probabilities: {} },
      location_角色丙: { type: 'choice', choice: S2, confidence: 0.9, probabilities: {} },
      perceive_角色丙: { type: 'noul', noul: 0.9 },   // 通话：能知道
      interact_角色丙: { type: 'noul', noul: 0.9 },   // 通话：能实时互动 → 双向接入
      mode_角色丙: { type: 'choice', choice: '语音', confidence: 0.9, probabilities: {} },
      knows_角色甲: { type: 'noul', noul: 0.05 },
      knows_角色乙: { type: 'noul', noul: 0.05 },
      knows_角色丙: { type: 'noul', noul: 0.9 },      // 通话传声 → 听得到呼叫这句
      told_角色丙: { type: 'noul', noul: 0.05 },
      state_dirty: { type: 'noul', noul: 0.1 },
    } })
    writeTestSettings(ds6.port, jev6.port)
    for await (const ev of session.speak('（测试发言·呼叫）')) {
      void ev
    }
    assert.ok(session.remoteLinks().some(l => l.character === '角色丙' && l.perceive === '语音'), '双向接入链接必须建立（语音）')
    assert.ok(session.speakableNames().includes('角色丙'), '接入者必须可发言')
    assert.equal(session.presentNames().includes('角色丙'), false, '接入者不在现场（位置仍是场景二）')
    assert.equal(session.snapshot().locations['角色丙'], S2, '通话不传送人：位置不动')
    const callMsg = session.snapshot().messages.find(m => m.text.includes('（测试发言·呼叫）'))
    const callVis = callMsg?.visible_to === 'all' ? [] : callMsg?.visible_to ?? []
    assert.ok(callVis.includes('角色丙'), '呼叫那句经 since 锚点能被丙听到')
    const replied = session.snapshot().messages.some(m => m.role === 'character' && m.name === '角色丙' && m.text.includes('（测试回复·接入）'))
    assert.ok(replied, '接入者必须能被路由接话')
    ds6.server.close(); jev6.server.close()
  }

  console.log('地图机制自检通过：场景文件层(创建/重名/描述可改/名称不可改) · 建群即建图 · 初始场景落位 · ⊘手选跳过判定生效(不问scene_change/present_*) · 目的地者直接在场听见进门句 · 同行者/离开者按location落位 · 判定移动与极严苛不动 · 对话进场晚于快照且入场包照常 · 一直在场者不入入场包 · 场景全文+当前场景注入角色 · 离开去向=其他清位 · 跨场景通话(双向接入建立/接入者可被路由/位置不动/呼叫句可听)')
} finally {
  rmSync(accDir, { recursive: true, force: true })
  if (hadSettings) writeFileSync(settingsFile, backup ?? '', 'utf8')
  else if (existsSync(settingsFile)) rmSync(settingsFile, { force: true })
  rmSync(settingsFile + '.selfcheck-bak', { force: true })
}
