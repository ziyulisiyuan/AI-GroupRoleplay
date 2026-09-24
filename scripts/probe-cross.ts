/**
 * 交叉验证探针（假端点，不产生真实 API 费用）。用完即删。
 * P1 角色调用里到底有没有 system 段 / 人设·状态·记忆·末尾指令有没有到达模型
 * P2 客户端中途断流：回复与记账到底落不落盘（对照"完整读完"那一组）
 * P3 现场+接入皆空 → 退回全员：不在场的角色能不能发言、他看得见你那句话吗
 */
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { config } from '../src/config.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'

const FAKE_PORT = 8931
const HOST_PORT = 8932
const base = `http://127.0.0.1:${HOST_PORT}`
const CAP = join(config.root, '.probe-capture.jsonl')
const groups = ['_xp-full', '_xp-abort', '_xp-empty', '_xp-c1', '_xp-c2', '_xp-c3']
const cleanup = (): void => {
  for (const g of groups) rmSync(join(config.groupsDir, g), { recursive: true, force: true })
  rmSync(CAP, { force: true })
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
const post = (path: string, body: unknown, signal?: AbortSignal): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) })

function makeGroup(name: string): string {
  const dir = join(config.groupsDir, name)
  mkdirSync(dir, { recursive: true })
  buildGroupFixture(dir, { chars: TEST_CAST.slice(0, 2) })
  return dir
}

const caps = (): Array<{ kind: string; hasSystem: boolean; systemLen: number; roles: string[]; firstUser: string; fullBody: string }> =>
  readFileSync(CAP, 'utf8').split('\n').filter(s => s.trim() !== '').map(s => JSON.parse(s) as never)

async function drain(res: Response, stopAfterFirstDelta: boolean): Promise<string[]> {
  const types: string[] = []
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line === '') continue
      const ev = JSON.parse(line) as { type: string }
      types.push(ev.type)
      if (stopAfterFirstDelta && ev.type === 'delta') { reader.cancel().catch(() => undefined); return [...types, '←在此断开'] }
    }
  }
  return types
}

function reportDir(label: string, dir: string): string {
  const cd = join(dir, '角色', '角色甲')
  const status = existsSync(join(cd, '状态.yaml')) ? readFileSync(join(cd, '状态.yaml'), 'utf8').trim() : '(无文件)'
  const mem = readFileSync(join(cd, '记忆.jsonl'), 'utf8').split('\n').filter(s => s.trim() !== '')
  const story = readFileSync(join(dir, '剧情.jsonl'), 'utf8').split('\n').filter(s => s.trim() !== '')
  const count = (t: string): number => story.filter(l => l.includes(t)).length
  const msgLines = story.filter(l => l.includes('"type":"msg"'))
  const lastMsg = msgLines.length > 0 ? JSON.parse(msgLines[msgLines.length - 1]) as { name: string; text: string; visible_to: unknown } : null
  return [
    `${label}`,
    `  状态.yaml: ${status === '' ? '(空)' : status.replace(/\n/g, ' / ')}`,
    `  甲记忆 ${mem.length} 条${mem.some(s => s.includes('导演记的账')) ? '（含导演记的那条 → 记账已执行）' : '（无导演的账 → 记账未执行）'}`,
    `  场记本: msg ${count('"type":"msg"')} 行 · route ${count('"type":"route"')} 行 · ledger ${count('"type":"ledger"')} 行 · 最后一条角色发言 ${lastMsg === null ? '(无)' : `「${String(lastMsg.text).slice(0, 20)}…」visible_to=${JSON.stringify(lastMsg.visible_to)}`}`,
  ].join('\n')
}

async function abortRun(name: string, text: string, mode: 'cancel' | 'controller', stopAt: 'delta' | 'route'): Promise<string[]> {
  const dir = makeGroup(name)
  const ac = new AbortController()
  const res = await post(`/api/group/${name}/message`, { text }, ac.signal)
  const seen: string[] = []
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  outer: for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line === '') continue
      const ev = JSON.parse(line) as { type: string }
      seen.push(ev.type)
      if (ev.type === stopAt) {
        if (mode === 'cancel') await reader.cancel().catch(() => undefined)
        else ac.abort()
        seen.push(`←${mode}@${stopAt}`)
        break outer
      }
    }
  }
  await sleep(3000)
  return [...seen, '\n' + reportDir(`  【${mode} 断在 ${stopAt}】`, dir)]
}


let fake: ChildProcess | undefined
let host: ChildProcess | undefined

try {
  cleanup()
  writeFileSync(CAP, '', 'utf8')
  const env = { ...process.env, DEEPSEEK_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`, DEEPSEEK_API_KEY: 'fake', DEEPSEEK_MODEL: 'fake-model', DEEPSEEK_REASONING_EFFORT: 'off', FAKE_STOP_MS: '1500' }
  fake = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('scripts', 'probe-fake-llm.ts'), String(FAKE_PORT), CAP], { cwd: config.root, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  fake.stderr!.on('data', () => undefined)
  await sleep(2500)
  host = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'server.ts')], { cwd: config.root, env: { ...env, HOST_PORT: String(HOST_PORT) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  host.stderr!.on('data', () => undefined)
  await sleep(4000)

  // ---------- P1 ----------
  const dirFull = makeGroup('_xp-full')
  const t1 = await drain(await post('/api/group/_xp-full/message', { text: '角色甲，你好' }), false)
  await sleep(500)
  console.log('\n=== P1 角色请求里到底装了什么 ===')
  console.log('事件序列:', t1.join(' '))
  for (const c of caps()) {
    const b = c.fullBody
    console.log(`\n[${c.kind}] 含 role=system: ${c.hasSystem}（长度 ${c.systemLen}）· 消息角色: ${c.roles.join(',')}`)
    if (c.kind === 'character') {
      for (const [name, needle] of [['人设背景', '测试背景'], ['外貌', '测试外观'], ['状态段', '你当前的身体与心理状态'], ['记忆段', '你已知悉的事'], ['场景段', '当前场景'], ['用户设定', '和你对话的人'], ['末尾指令', '必须包含他说出口的台词'], ['世界观', '世界观']] as const) {
        console.log(`   请求体里出现「${name}」: ${b.includes(needle) ? '是' : '否 ← 从未发给模型'}`)
      }
      console.log(`   首条 user 内容: ${c.firstUser.replace(/\n/g, ' ⏎ ')}`)
    }
  }
  console.log(reportDir('', dirFull))

  // ---------- P2 ----------
  console.log('\n=== P2 客户端断流：三种断法，看回复与记账落不落盘 ===')
  for (const [name, mode, stopAt] of [
    ['_xp-c1', 'cancel', 'delta'], ['_xp-c2', 'controller', 'delta'], ['_xp-c3', 'controller', 'route'],
  ] as const) {
    console.log((await abortRun(name, `角色甲，这轮用 ${mode}@${stopAt} 断开`, mode, stopAt)).join('\n'))
  }

  // ---------- P3 ----------
  const dirEmpty = makeGroup('_xp-empty')
  await fetch(`${base}/api/group/_xp-empty/presence`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ present: [] }) })
  const n0 = caps().length
  const t3 = await drain(await post('/api/group/_xp-empty/message', { text: '屋里一个人都没有，这句是空场测试' }), false)
  await sleep(400)
  console.log('\n=== P3 现场+接入都为空（总管明确判"现场无人"）===')
  console.log('事件序列:', t3.join(' '))
  console.log(reportDir('', dirEmpty))
  const c3 = caps().slice(n0).filter(c => c.kind === 'character')
  console.log(`  空场下仍被调用的角色请求数: ${c3.length}`)
  for (const c of c3) {
    console.log(`  他的请求里消息条数=${c.roles.length}（内容: ${c.roles.join(',') || '无'}）· 是否含"空场测试"这句: ${c.fullBody.includes('空场测试') ? '含' : '不含 ← 他能发言，却看不见你刚说的话'}`)
  }
} finally {
  host?.kill()
  fake?.kill()
  await sleep(400)
  cleanup()
  console.log('\n探针夹具与抓包文件已清理:', !existsSync(CAP) && groups.every(g => !existsSync(join(config.groupsDir, g))))
}
