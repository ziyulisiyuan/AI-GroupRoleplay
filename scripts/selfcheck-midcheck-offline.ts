/**
 * 中间判定离线自检（无需真实 API key，全部本地 mock 端点）：
 * 1) 规则文件：两段固定格式的读写、启用过滤（缺第二段 = 不参与）、坏行忽略。
 * 2) 无规则：不发起任何判定，草稿即最终输出——流式回放与真实流走同一条 delta 通道。
 * 3) 命中：每条规则**各发一次** Jev（互不共享题面），只有命中的第二段拼进改稿指令；
 *    最终落盘的只有改稿后的文本，草稿不进日志/记忆；思维链两段都留。
 * 4) 失败：Jev 单条失败按未命中处理，草稿即最终输出（绝不卡住剧情）。
 */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'
import { loadMidCheckList, loadMidChecks, saveMidCheckList } from '../src/group/midcheck.ts'

const accName = '_selfcheck-midcheck'
const accDir = join(config.groupsDir, accName)
const settingsFile = join(config.root, 'settings.yaml')
const midFile = join(config.root, '中间判定.jsonl')
const hadSettings = existsSync(settingsFile)
const settingsBackup = hadSettings ? readFileSync(settingsFile, 'utf8') : undefined
const hadMid = existsSync(midFile)
const midBackup = hadMid ? readFileSync(midFile, 'utf8') : undefined
writeFileSync(settingsFile + '.selfcheck-bak', settingsBackup ?? '', 'utf8')

/** mock Jev：中间判定的题面里带「规则A/规则B/规则C」，据此返回脚本化概率；其余题给通用答案。 */
async function mockJev(script: { noulByRule?: Record<string, number>; failRule?: string }): Promise<{ server: Server; port: number; hits: Array<Record<string, unknown>> }> {
  const hits: Array<Record<string, unknown>> = []
  const server = createServer((req, res) => {
    let buf = ''
    req.on('data', (c: Buffer) => { buf += c })
    req.on('end', () => {
      const body = JSON.parse(buf) as Record<string, unknown>
      const questions = (body.questions ?? {}) as Record<string, { type: string; instructions?: string; criteria?: Record<string, string> }>
      hits.push({ url: req.url, body })
      if (questions.violation !== undefined) {
        const ins = questions.violation.instructions ?? ''
        if (script.failRule !== undefined && ins.includes(script.failRule)) {
          res.statusCode = 500
          res.end('boom')
          return
        }
        const key = Object.keys(script.noulByRule ?? {}).find(k => ins.includes(k))
        const noul = key === undefined ? 0.05 : (script.noulByRule ?? {})[key]
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ model: 'jev-test', answers: { violation: { type: 'noul', noul } } }))
        return
      }
      // 主判定/路由/回复判定：通用答案（choice 选第一个非「你」的选项，其余 noul 给高值）
      const answers: Record<string, unknown> = {}
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === 'noul') answers[id] = { type: 'noul', noul: id === 'briefs' ? 0 : id.startsWith('told_') ? 0.05 : 0.9 }
        else {
          const keys = Object.keys(q.criteria ?? {})
          const pick = keys.find(k => k !== '你' && k !== '未移动') ?? keys[0] ?? ''
          answers[id] = { type: 'choice', choice: pick, confidence: 0.9, probabilities: Object.fromEntries(keys.map(k => [k, k === pick ? 0.9 : 0])) }
        }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ model: 'jev-test', answers }))
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, port, hits }
}

/** mock 对话模型：按顺序吐出 streamSeq 里的文本（SSE），并记下每次请求体。
 *  failFrom = 从第 N 次调用起一律 500（用来钉"改稿失败不能丢掉这一轮"）。 */
async function mockChat(streamSeq: string[], reasoning = '（测试思考）', failFrom?: number): Promise<{ server: Server; port: number; hits: Array<Record<string, unknown>> }> {
  const hits: Array<Record<string, unknown>> = []
  const server = createServer((req, res) => {
    let buf = ''
    req.on('data', (c: Buffer) => { buf += c })
    req.on('end', () => {
      const body = JSON.parse(buf) as Record<string, unknown>
      hits.push(body)
      if (failFrom !== undefined && hits.length >= failFrom) { res.statusCode = 500; res.end('boom'); return }
      const text = streamSeq[Math.min(hits.length - 1, streamSeq.length - 1)] ?? ''
      res.setHeader('content-type', 'text/event-stream')
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: reasoning } }] }) + '\n\n')
      if (text !== '') res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return { server, port, hits }
}

function writeTestSettings(dsPort: number, jevPort: number): void {
  writeFileSync(settingsFile, `activeId: pd\nrouterId: pj\nproviders:\n  - { id: pd, name: chat-mock, baseUrl: 'http://127.0.0.1:${dsPort}', apiKey: fake, model: fake-model, reasoningEffort: off }\n  - { id: pj, name: jev-mock, baseUrl: 'http://127.0.0.1:${jevPort}', apiKey: fake, model: jev-test, reasoningEffort: off }\n`, 'utf8')
}

function setRules(list: Array<{ id: string; name: string; enabled: boolean; check: string; fix: string }>): void {
  writeFileSync(midFile, list.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

function jsonl(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '').flatMap(l => { try { return [JSON.parse(l) as Record<string, unknown>] } catch { return [] } })
}

try {
  // ── 1) 规则文件：两段固定格式读写 + 启用/缺段过滤
  {
    const dir = mkdtempSync(join(tmpdir(), 'midcheck-'))
    try {
      saveMidCheckList([
        { id: 'r1', name: '规则A', enabled: true, check: '不得替用户说话', fix: '不要替用户决定他要做什么' },
        { id: 'r2', name: '规则B', enabled: false, check: '不得出现现代词', fix: '换掉现代词' },
        { id: 'r3', name: '规则C', enabled: true, check: '', fix: '（缺第一段）' },
        { id: 'r4', name: '规则D', enabled: true, check: '不得描写心理', fix: '   ' },
      ], dir)
      const all = loadMidCheckList(dir)
      assert.equal(all.length, 4, '四条都应读出')
      assert.deepEqual(loadMidChecks(dir).map(r => r.name), ['规则A'], '只有启用且两段都齐的规则参与判定')
      assert.ok(readFileSync(join(dir, '中间判定.jsonl'), 'utf8').startsWith('{"id":"r1","name":"规则A","enabled":true,"check"'), '键序固定（确定性序列化）')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  const { GroupSession } = await import('../src/group/engine.ts')

  // ── 2) 无规则：一次都不判，草稿即最终输出（流式回放照走 delta）
  {
    setRules([])
    const draftText = '（无规则直通，不应有回放等待）'.repeat(40)
    const chat = await mockChat([draftText])
    const jev = await mockJev({})
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST })
    writeTestSettings(chat.port, jev.port)
    const session = GroupSession.open(accName)
    const deltas: string[] = []
    const replies: string[] = []
    const t0 = Date.now()
    for await (const ev of session.speak('（无规则测试）')) {
      if (ev.type === 'delta') deltas.push(ev.text)
      if (ev.type === 'reply') replies.push(ev.text)
    }
    const elapsed = Date.now() - t0
    assert.equal(jev.hits.filter(h => JSON.stringify(h.body).includes('violation')).length, 0, '没有规则：一次 Jev 中间判定都不发')
    assert.equal(chat.hits.length, 1, '没有规则：只生成一次（留作最终输出）')
    assert.equal(deltas.join(''), draftText, '直通：文本必须完整上屏')
    assert.ok(elapsed < 800, `零启用规则必须直通（不攒稿、不模拟回放）——这段 ${draftText.length} 字若走回放要约 ${(draftText.length / 225).toFixed(1)}s，实耗 ${elapsed}ms`)
    assert.equal(replies.at(-1), draftText, '最终输出 = 生成的文本')
    assert.equal(session.snapshot().messages.at(-1)?.text, draftText, '落盘的是最终输出')
    assert.ok(!jsonl(join(accDir, '判定.jsonl')).some(r => r.phase === '中间判定'), '没有规则时不记中间判定行')
    const stages = jsonl(join(accDir, '思维链.jsonl')).map(r => r.stage)
    assert.deepEqual(stages, ['循环前'], '没有改稿就没有循环后思维链')
    chat.server.close(); jev.server.close()
  }

  // ── 3) 命中 + 未命中：每条规则各发一次（题面互不共享），只有命中的第二段进改稿指令
  {
    setRules([
      { id: 'r1', name: '规则A', enabled: true, check: '不得替用户说话', fix: '不要替用户决定他要做什么' },
      { id: 'r2', name: '规则B', enabled: true, check: '不得出现现代词', fix: '把现代词换掉' },
    ])
    const chat = await mockChat(['草稿：好，我这就替你把门推开了。', '改稿：我退到门边，等你示下。'])
    const jev = await mockJev({ noulByRule: { '不得替用户说话': 0.91, '不得出现现代词': 0.07 } })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST })
    writeTestSettings(chat.port, jev.port)
    const session = GroupSession.open(accName)
    const deltas: string[] = []
    for await (const ev of session.speak('（命中测试）')) if (ev.type === 'delta') deltas.push(ev.text)
    const midHits = jev.hits.filter(h => JSON.stringify(h.body).includes('violation'))
    assert.equal(midHits.length, 2, '两条规则 = 两次独立判定（并发、互不共享题面）')
    for (const h of midHits) {
      const qs = ((h.body as Record<string, unknown>).questions ?? {}) as Record<string, unknown>
      assert.deepEqual(Object.keys(qs), ['violation'], '每次判定只带这一条规则（不把全部规则塞给同一个 Jev）')
      assert.ok(JSON.stringify(h.body).includes('草稿：好，我这就'), '判定的输入必须包含这段中间输出')
      assert.ok(JSON.stringify(h.body).includes('（命中测试）'), '判定的输入包含用户刚说的那句')
    }
    assert.equal(chat.hits.length, 2, '命中后重写一次：共两次生成')
    const rev = chat.hits[1] as { messages: Array<{ role: string; content: string }> }
    const msgs = rev.messages
    assert.equal(msgs.at(-2)?.role, 'assistant', '改稿请求：草稿以 assistant 身份带上')
    assert.ok((msgs.at(-2)?.content ?? '').includes('我这就替你把门推开了'), '改稿请求必须带完整草稿')
    const fixMsg = msgs.at(-1)?.content ?? ''
    assert.ok(fixMsg.startsWith('以下要求你的输出未满足，请据此重写，只输出改后的内容：'), '改稿指令开头固定句')
    assert.ok(fixMsg.includes('不要替用户决定他要做什么'), '命中的第二段必须进改稿指令')
    assert.ok(!fixMsg.includes('把现代词换掉'), '未命中的第二段绝不进改稿指令')
    assert.ok(msgs.some(m => m.role === 'system' && m.content.includes('角色甲')), '改稿请求仍带完整角色上下文（不是只给草稿）')
    assert.equal(deltas.join(''), '改稿：我退到门边，等你示下。', '上屏的是改稿后的文本')
    const finalText = session.snapshot().messages.at(-1)?.text ?? ''
    assert.equal(finalText, '改稿：我退到门边，等你示下。', '落盘的是改稿后的文本')
    assert.ok(!readFileSync(join(accDir, '剧情.jsonl'), 'utf8').includes('我这就替你把门推开了'), '草稿永不落盘（日志里只有最终输出）')
    const stages = jsonl(join(accDir, '思维链.jsonl')).map(r => r.stage).sort()
    assert.deepEqual(stages, ['循环后', '循环前'].sort(), '两段思维链都要留')
    const midRow = jsonl(join(accDir, '判定.jsonl')).find(r => r.phase === '中间判定')
    assert.ok(midRow !== undefined, '中间判定必须落判定日志')
    assert.deepEqual(midRow?.hits, ['规则A'], '判定日志记录命中的规则')
    const verdicts = midRow?.verdicts as Array<{ name: string; noul?: number }>
    assert.equal(verdicts.length, 2, '每条规则的原始概率都要留痕')
    assert.ok(verdicts.some(v => v.name === '规则B' && v.noul === 0.07), '未命中规则的原始概率也要留痕')
    chat.server.close(); jev.server.close()
  }

  // ── 4) 判定失败：按未命中处理——草稿即最终输出，绝不卡住剧情
  {
    setRules([{ id: 'r1', name: '规则A', enabled: true, check: '不得替用户说话', fix: '不要替用户决定' }])
    const chat = await mockChat(['（Jev 挂了也要有输出）'])
    const jev = await mockJev({ failRule: '不得替用户说话' })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST })
    writeTestSettings(chat.port, jev.port)
    const session = GroupSession.open(accName)
    for await (const _ of session.speak('（判定失败测试）')) { /* 跑完 */ }
    assert.equal(chat.hits.length, 1, '判定失败：不重写，只有一次生成')
    assert.equal(session.snapshot().messages.at(-1)?.text, '（Jev 挂了也要有输出）', '判定失败：草稿即最终输出')
    const midRow = jsonl(join(accDir, '判定.jsonl')).find(r => r.phase === '中间判定')
    assert.ok(midRow !== undefined && Array.isArray(midRow.verdicts), '失败也要留判定日志')
    assert.ok((midRow?.verdicts as Array<{ error?: string }>).some(v => v.error !== undefined), '失败原因要落盘')
    chat.server.close(); jev.server.close()
  }

  // ── 5) 改稿调用失败：草稿即最终输出（不能把这一轮丢掉）
  {
    setRules([{ id: 'r1', name: '规则A', enabled: true, check: '不得替用户说话', fix: '不要替用户决定' }])
    const chat = await mockChat(['（改稿挂了也不能丢这一轮）'], '（测试思考）', 2)
    const jev = await mockJev({ noulByRule: { '不得替用户说话': 0.95 } })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST })
    writeTestSettings(chat.port, jev.port)
    const session = GroupSession.open(accName)
    for await (const _ of session.speak('（改稿失败测试）')) { /* 跑完 */ }
    assert.equal(session.snapshot().messages.at(-1)?.text, '（改稿挂了也不能丢这一轮）', '改稿失败：草稿即最终输出')
    const row = jsonl(join(accDir, '判定.jsonl')).find(r => r.phase === '中间判定' && r.error !== undefined)
    assert.ok(row !== undefined, '改稿失败必须留判定日志（含原因）')
    chat.server.close(); jev.server.close()
  }

  // ── 6) 本群独立规则 / 独立判定（只作用于这个群）：全局为空时，群目录里的两份照样生效
  {
    setRules([])
    const chat = await mockChat(['草稿：本群规则测试。', '改稿：本群判定生效。'])
    const jev = await mockJev({ noulByRule: { '不得替用户说话': 0.9 } })
    rmSync(accDir, { recursive: true, force: true })
    buildGroupFixture(accDir, { chars: TEST_CAST })
    writeTestSettings(chat.port, jev.port)
    // 群目录里的两本：独立规则（自由文本，注入角色提示词）+ 独立中间判定
    writeFileSync(join(accDir, '规则.jsonl'), JSON.stringify({ id: 'g1', name: '本群规则', enabled: true, text: '（本群专属规则标记）' }) + '\n', 'utf8')
    writeFileSync(join(accDir, '中间判定.jsonl'), JSON.stringify({ id: 'gm1', name: '本群判定', enabled: true, check: '不得替用户说话', fix: '不要替用户决定' }) + '\n', 'utf8')
    // 个人知识库：每个角色各写一份不同的标记——只有发言者自己那份能进提示词，且绝不进任何 Jev 判定
    for (const c of TEST_CAST) {
      writeFileSync(join(accDir, '角色', c.dir, '知识库.md'), `（${c.name}的私人知识库标记）\n`, 'utf8')
    }
    const session = GroupSession.open(accName)
    let speaker = ''
    for await (const ev of session.speak('（本群独立测试）')) if (ev.type === 'speaker') speaker = ev.name
    assert.notEqual(speaker, '', '必须有发言者')
    assert.equal(jev.hits.filter(h => JSON.stringify(h.body).includes('violation')).length, 1, '本群独立判定必须生效（全局为空也一样）')
    assert.equal(chat.hits.length, 2, '本群判定命中 → 改稿一次')
    assert.ok(JSON.stringify(chat.hits[0]).includes('（本群专属规则标记）'), '本群独立规则必须注入角色提示词')
    const firstBody = JSON.stringify(chat.hits[0])
    assert.ok(firstBody.includes(`（${speaker}的私人知识库标记）`), '个人知识库必须注入发言者自己的提示词')
    for (const c of TEST_CAST) {
      if (c.name !== speaker) assert.ok(!firstBody.includes(`（${c.name}的私人知识库标记）`), '别的角色的知识库不得混进来')
    }
    assert.ok(jev.hits.every(h => !/的私人知识库标记/.test(JSON.stringify(h.body))), '个人知识库绝不进任何 Jev 判定')
    assert.equal(session.snapshot().messages.at(-1)?.text, '改稿：本群判定生效。', '本群落盘的是改稿后的文本')
    // 别的群读不到这两份：换一个群名打开（同一目录的另一份夹具）
    const otherDir = join(config.groupsDir, accName + '-other')
    rmSync(otherDir, { recursive: true, force: true })
    buildGroupFixture(otherDir, { chars: TEST_CAST })
    const { loadMidChecksFor } = await import('../src/group/midcheck.ts')
    assert.equal(loadMidChecksFor(otherDir).length, 0, '本群判定只作用于本群（另一个群读不到）')
    rmSync(otherDir, { recursive: true, force: true })
    chat.server.close(); jev.server.close()
  }

  console.log('中间判定自检通过：规则两段格式读写/启用过滤 · 无规则零判定(直通) · 每条规则各发一次(题面互不共享) · 只有命中的第二段进改稿指令 · 草稿永不落盘 · 思维链两段 · 判定失败=草稿即最终 · 改稿失败=草稿即最终 · 本群独立规则/独立判定生效且不外溢')
} finally {
  rmSync(accDir, { recursive: true, force: true })
  if (hadSettings) writeFileSync(settingsFile, settingsBackup ?? '', 'utf8')
  else if (existsSync(settingsFile)) rmSync(settingsFile, { force: true })
  rmSync(settingsFile + '.selfcheck-bak', { force: true })
  if (hadMid) writeFileSync(midFile, midBackup ?? '', 'utf8')
  else if (existsSync(midFile)) rmSync(midFile, { force: true })
}
