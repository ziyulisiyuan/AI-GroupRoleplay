/**
 * 地图机制离线自检（无需 API key；本地 mock 端点）：
 * 1) 场景文件层：创建/列表/重名拒绝/描述可改（名称不可改不可删）/非法名拒绝。
 * 2) 建群即建图：群设定 scene + 场景文件；角色初始场景 → 引擎初始状态（同场景者现场，他者不在）。
 * 3) ⊘ 手选移动：跳过 scene_change 判定（questions 无此题）；目的地里的人直接在场并听见进门这句；
 *    跟随者（present 高）落位；离开者（present 低）按"去向（其他/某场景）"落位；一直在目的地者不入入场包。
 * 4) 判定移动：scene_change choice 命中（含置信阈值）；未命中/未移动不动。
 * 5) 对话进场：present 高的非在场者落位当前场景（晚于快照：不在 visible_to），入场包照常注入。
 * 6) 场景全文注入角色（assembleGroup）。
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
        res.end(JSON.stringify({ choices: [{ message: { content: '', tool_calls: [{ function: { name: 'record_scene', arguments: JSON.stringify({ scene_summary: script.scene ?? '（现场无异样）' }) } }] } }] }))
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
  createScene(accDir, '大院', '（开阔的青石大院，两株老槐）')
  createScene(accDir, '卧室', '（狭小的卧房，一床一桌）')
  assert.throws(() => createScene(accDir, '大院', 'x'), /已存在/, '重名拒绝')
  assert.throws(() => createScene(accDir, 'a/b', 'x'), /非法/, '非法名拒绝')
  saveSceneDescription(accDir, '大院', '（改后的院子描述）')
  assert.equal(listScenes(accDir).find(s => s.name === '大院')?.description, '（改后的院子描述）', '描述可改')
  assert.equal(listScenes(accDir).find(s => s.name === '大院')?.name, '大院', '名称不可改')
  rmSync(accDir, { recursive: true, force: true })

  // ── 2) 建群即建图 + 初始状态
  createGroup(accDir, { era: '（测试时代）', world: '（测试世界）', tone: '', scene: '大院' }, [
    { name: '大院', description: '（开阔的青石大院，两株老槐）' },
    { name: '卧室', description: '（狭小的卧房，一床一桌）' },
  ])
  assert.equal(loadGroupSettings(accDir).scene, '大院', '初始当前场景落群设定')
  makeChar(accDir, '角色甲', '大院')
  makeChar(accDir, '角色乙', '大院')
  makeChar(accDir, '角色丙', '卧室')

  const ds = await mockDeepseek({ streamText: '（测试回复）', scene: '（狭小的卧房，一床一桌，被褥整齐。）' })
  const jev = await mockJev({ answers: [
    { // 第1轮主判定：⊘ 手选（scene_change 不应被问）；甲跟随（present 0.95→落位卧室），乙留下（present 0.1→去向大院），丙原位
      next_speaker: { type: 'choice', choice: '角色甲', confidence: 0.9, probabilities: {} },
      present_角色甲: { type: 'noul', noul: 0.95 },
      present_角色乙: { type: 'noul', noul: 0.1 },
      present_角色丙: { type: 'noul', noul: 0.95 },
      location_角色甲: { type: 'choice', choice: '卧室', confidence: 0.9, probabilities: {} },
      location_角色乙: { type: 'choice', choice: '大院', confidence: 0.9, probabilities: {} },
      location_角色丙: { type: 'choice', choice: '卧室', confidence: 0.9, probabilities: {} },
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
  assert.equal(session.snapshot().scene, '大院')

  const events: Array<{ type: string; text?: string; picked?: string }> = []
  for await (const ev of session.speak('我走进卧室看看', '卧室')) {
    events.push(ev.type === 'route' ? { type: 'route', picked: ev.picked } : { type: ev.type, text: 'text' in ev ? ev.text : undefined })
  }
  // ⊘ 手选跳过判定：questions 里没有 scene_change
  const askedKeys = Object.keys((jev.hits[0]?.body as { questions: Record<string, unknown> }).questions)
  assert.ok(!askedKeys.includes('scene_change'), '手选时不得再问换场景判定')
  assert.ok(askedKeys.includes('location_角色甲'), '位置判定必须问')
  assert.equal(session.snapshot().scene, '卧室', '手选生效：当前场景=卧室')
  assert.deepEqual(session.presentNames().sort(), ['角色甲', '角色丙'].sort(), '目的地里的人 + 跟随者现场；留下的乙不在')
  const snapMsg = session.snapshot().messages.find(m => m.text === '我走进卧室看看')
  const vis = snapMsg?.visible_to === 'all' ? [] : snapMsg?.visible_to ?? []
  assert.ok(vis.includes('角色丙') && vis.includes('角色甲'), '目的地里的人与跟随者听见进门这句')
  assert.ok(!vis.includes('角色乙'), '留在原地的乙听不到')
  assert.ok(events.some(e => e.type === 'info' && (e.text ?? '').includes('手选')), '场景更新事件必须标注手选')
  // 丙一直在目的地（位置没变）→ 不入入场包；甲随行（位置变了）→ 入场包
  await sleep(1200)
  assert.ok(!memOf('角色丙').includes('现场所见'), '一直在目的地者不得获得现场所见')
  assert.ok(memOf('角色甲').includes('现场所见'), '随行者进入新场景必须获得现场所见')

  // ── 3) 判定移动回大院（scene_change 命中）；甲丙留下（去向=卧室）
  ds.server.close(); jev.server.close()
  const events2: Array<{ type: string; text?: string }> = []
  const ds2 = await mockDeepseek({ streamText: '（测试回复）' })
  const jev2 = await mockJev({ answers: [
    { // 主判定：scene_change 命中大院；甲丙留下（present 低 → 去向卧室）；乙在场
      next_speaker: { type: 'choice', choice: '角色乙', confidence: 0.9, probabilities: {} },
      scene_change: { type: 'choice', choice: '大院', confidence: 0.9, probabilities: {} },
      present_角色甲: { type: 'noul', noul: 0.1 },
      present_角色乙: { type: 'noul', noul: 0.95 },
      present_角色丙: { type: 'noul', noul: 0.1 },
      location_角色甲: { type: 'choice', choice: '卧室', confidence: 0.9, probabilities: {} },
      location_角色乙: { type: 'choice', choice: '大院', confidence: 0.9, probabilities: {} },
      location_角色丙: { type: 'choice', choice: '卧室', confidence: 0.9, probabilities: {} },
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
  for await (const ev of session.speak('我回到大院')) {
    events2.push({ type: ev.type, text: 'text' in ev ? ev.text : undefined })
  }
  assert.equal(session.snapshot().scene, '大院', '判定移动生效')
  assert.deepEqual(session.presentNames(), ['角色乙'], '留在卧室的甲丙不在现场')
  const backMsg = session.snapshot().messages.find(m => m.text === '我回到大院')
  const backVis = backMsg?.visible_to === 'all' ? [] : backMsg?.visible_to ?? []
  assert.deepEqual(backVis, ['角色乙'], '乙（在大院）听见回来这句；甲丙（卧室）听不到')

  // ── 4) 严苛不移动：scene_change=未移动 → 提到别处也不动
  jev2.hits.length = 0
  const ds3 = await mockDeepseek({ streamText: '（测试回复）' })
  const jev3 = await mockJev({ answers: {
    next_speaker: { type: 'choice', choice: '角色乙', confidence: 0.9, probabilities: {} },
    scene_change: { type: 'choice', choice: '未移动', confidence: 0.9, probabilities: {} },
    present_角色甲: { type: 'noul', noul: 0.1 },
    present_角色乙: { type: 'noul', noul: 0.95 },
    present_角色丙: { type: 'noul', noul: 0.1 },
    location_角色甲: { type: 'choice', choice: '卧室', confidence: 0.9, probabilities: {} },
    location_角色乙: { type: 'choice', choice: '大院', confidence: 0.9, probabilities: {} },
    location_角色丙: { type: 'choice', choice: '卧室', confidence: 0.9, probabilities: {} },
    knows_角色乙: { type: 'noul', noul: 0.95 },
    told_角色乙: { type: 'noul', noul: 0.05 },
    state_dirty: { type: 'noul', noul: 0.1 },
  } })
  writeTestSettings(ds3.port, jev3.port)
  for await (const ev of session.speak('（说起郡县旁的湖泊）')) void ev
  assert.equal(session.snapshot().scene, '大院', '极严苛：提到未建图地点/未明确移动 = 不动')

  // ── 5) 对话进场：丙被点名进来 → 落位当前场景，但听不到召唤这句；入场包注入
  jev3.hits.length = 0
  const ds4 = await mockDeepseek({ streamText: '（测试回复）', scene: '（院子里老槐的影子铺在地上。）' })
  const jev4 = await mockJev({ answers: [
    { // 主判定：丙明确进场（present 0.9）；甲仍在卧室
      next_speaker: { type: 'choice', choice: '角色丙', confidence: 0.9, probabilities: {} },
      present_角色甲: { type: 'noul', noul: 0.1 },
      present_角色乙: { type: 'noul', noul: 0.95 },
      present_角色丙: { type: 'noul', noul: 0.9 },
      location_角色甲: { type: 'choice', choice: '卧室', confidence: 0.9, probabilities: {} },
      location_角色乙: { type: 'choice', choice: '大院', confidence: 0.9, probabilities: {} },
      location_角色丙: { type: 'choice', choice: '大院', confidence: 0.9, probabilities: {} },
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
  for await (const ev of session.speak('（把丙叫了进来）丙你进来')) void ev
  const callMsg = session.snapshot().messages.find(m => m.text.includes('丙你进来'))
  const callVis = callMsg?.visible_to === 'all' ? [] : callMsg?.visible_to ?? []
  assert.ok(!callVis.includes('角色丙'), '刚进场者听不到召唤这句')
  assert.ok(session.presentNames().includes('角色丙'), '对话明确进场 → 落位当前场景')
  for (let i = 0; i < 40; i++) {
    if (memOf('角色丙').includes('现场所见')) break
    await sleep(250)
  }
  assert.ok(memOf('角色丙').includes('老槐的影子'), '进场者必须先拿到现场所见再开口')

  // ── 6) 场景全文注入角色
  const streamHit = ds4.hits.filter(h => h.kind === 'stream').at(-1)
  assert.ok(streamHit !== undefined, '必须有角色生成调用')
  const prompt = JSON.stringify(streamHit.body)
  assert.ok(prompt.includes('（开阔的青石大院'), '地图全文注入：大院')
  assert.ok(prompt.includes('（狭小的卧房'), '地图全文注入：卧室')
  assert.ok(prompt.includes('当前场景：大院'), '当前场景标注')

  // ── 7) 离开者去向=其他：乙离开且对话没说去哪 → 位置清空（其他）；下次回大院他不在
  const ds5 = await mockDeepseek({ streamText: '（测试回复）' })
  const jev5 = await mockJev({ answers: [
    { // 主判定：乙明确离开（present 0.05），去向未提及 → 其他
      next_speaker: { type: 'choice', choice: '角色丙', confidence: 0.9, probabilities: {} },
      present_角色甲: { type: 'noul', noul: 0.1 },
      present_角色乙: { type: 'noul', noul: 0.05 },
      present_角色丙: { type: 'noul', noul: 0.95 },
      location_角色甲: { type: 'choice', choice: '卧室', confidence: 0.9, probabilities: {} },
      location_角色乙: { type: 'choice', choice: '其他', confidence: 0.9, probabilities: {} },
      location_角色丙: { type: 'choice', choice: '大院', confidence: 0.9, probabilities: {} },
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
  for await (const ev of session.speak('（乙转身出门走了）')) void ev
  assert.ok(!session.presentNames().includes('角色乙'), '明确离开 → 不在现场')
  const stored = (session as unknown as { scene: { locations?: Record<string, string> } }).scene
  assert.ok(!Object.keys(stored.locations ?? {}).includes('角色乙'), '去向=其他 → 位置清空（图外）')

  ds2.server.close(); jev2.server.close()
  ds3.server.close(); jev3.server.close()
  ds4.server.close(); jev4.server.close()
  ds5.server.close(); jev5.server.close()

  console.log('地图机制自检通过：场景文件层(创建/重名/描述可改/名称不可改) · 建群即建图 · 初始场景落位 · ⊘手选跳过判定生效(不问scene_change) · 目的地者直接在场听见进门句 · 跟随者/离开者落位 · 判定移动与极严苛不动 · 对话进场晚于快照且入场包照常 · 一直在场者不入入场包 · 场景全文+当前场景注入角色 · 离开去向=其他清位')
} finally {
  rmSync(accDir, { recursive: true, force: true })
  if (hadSettings) writeFileSync(settingsFile, backup ?? '', 'utf8')
  else if (existsSync(settingsFile)) rmSync(settingsFile, { force: true })
  rmSync(settingsFile + '.selfcheck-bak', { force: true })
}
