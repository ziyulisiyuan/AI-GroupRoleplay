/**
 * 场景人员验收（SPEC §6 M9）——**总管从剧情判断**，用户只看显示：
 * ① 开场剧情说明谁在场 → 总管据此设定名单（不由用户勾选）。
 * ② 在场者听到、不在场者不知道。
 * ③ 剧情里有人进来 → 总管更新名单 → 之后的事他才开始知道（旧事仍不知道）。
 * ④ 感知障碍：某角色失聪 → 即使在场也不记入知情。
 * ⑤ 远程接入（电话/视频一类双向通道）：不在现场但**能发言**；知情**不由程序自动登记**，
 *    而由总管按通道逐轮显式记录（听到什么记什么）——机制层保证"不自动登记"，判断层验证"记录到位"。
 * ⑥ rebuild 后场景人员一致（presence 行是事实源）。
 * 群目录 groups/_acc-presence 由夹具现造，结束（含失败路径）必删。
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'
import { loadScene, presencePath } from '../src/group/presence.ts'

const accGroup = '_acc-presence'
const accDir = join(config.groupsDir, accGroup)
const PORT = 8796
const base = `http://127.0.0.1:${PORT}`
const cleanup = (): void => rmSync(accDir, { recursive: true, force: true })

const [A, B, C] = TEST_CAST

const server = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'server.ts')], {
  cwd: config.root, env: { ...process.env, HOST_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
})

const postJson = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function say(text: string): Promise<string> {
  const res = await postJson(`/api/group/${accGroup}/message`, { text })
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (line === '') continue
      const ev = JSON.parse(line) as { type: string; text?: string }
      if (ev.type === 'delta') out += ev.text ?? ''
    }
  }
  return out
}
interface RemoteLink { character: string; perceive: '语音' | '视听'; note?: string }
interface Snap { present: string[]; remote: RemoteLink[]; absent: string[] }
const snapshot = async (): Promise<Snap> => await (await fetch(`${base}/api/group/${accGroup}`)).json() as Snap
const memoryText = (name: string): string => {
  const p = join(accDir, '角色', name, '记忆.jsonl')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}
/** 该角色的记忆里是否有"来自第 N 条消息"的自动登记条目（机制层证据，确定性）。 */
const hasAutoEntryFor = (name: string, mid: number): boolean =>
  memoryText(name).split('\n').some(l => l.includes(`"mid":${mid}`))
/** 从日志取全部行。 */
const lines = (): Array<{ type: string; id?: number; role?: string; name?: string; text?: string; visible_to?: string[] | string }> =>
  readFileSync(join(accDir, '剧情.jsonl'), 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l))
/** 从日志里取某条消息的可见名单（快照）。 */
const visibleToOf = (id: number): string[] => {
  const line = lines().find(l => l.type === 'msg' && l.id === id)
  return Array.isArray(line?.visible_to) ? line.visible_to : []
}
/** 最后一条角色发言的名（判断"某人能不能发言"用）。 */
const lastSpeaker = (): string | undefined => [...lines()].reverse().find(l => l.type === 'msg' && l.role === 'character')?.name
/** 总管自己写进记忆的条目（判断层，可能出错；出错时有纠正窗口兜）。 */
const directorEntriesMentioning = (name: string, keyword: string): string[] =>
  memoryText(name).split('\n').filter(l => l.includes(keyword) && !l.includes('"mid"')).map(l => l.trim())
const setStatus = (name: string, fields: Record<string, string>): void => {
  writeFileSync(join(accDir, '角色', name, '状态.yaml'), Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n', 'utf8')
}

async function waitListening(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/groups`)).ok) return } catch { /* 未就绪 */ }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error('server 未就绪')
}

/**
 * 反复用不同措辞提示场景，直到总管的场景人员满足判定（LLM 判断有抖动，给有界重试）。
 * 断言仍然严格：重试用尽仍不满足就失败。
 */
async function ensureScene(check: (s: Snap) => boolean, cues: string[]): Promise<Snap> {
  let snap = await snapshot()
  for (const cue of cues) {
    if (check(snap)) return snap
    console.log(`  （当前现场 ${JSON.stringify(snap.present)}｜接入 ${JSON.stringify(snap.remote)}，再提示一次场景）`)
    await say(cue)
    snap = await snapshot()
  }
  return snap
}

/** 反复提示直到指定角色发言（验证"他能不能发言"这条权限）。 */
async function untilSpeaks(name: string, cues: string[]): Promise<boolean> {
  for (const cue of cues) {
    await say(cue)
    if (lastSpeaker() === name) return true
  }
  return false
}

try {
  cleanup()
  buildGroupFixture(accDir, { chars: TEST_CAST })
  await waitListening()

  // ① 开场剧情交代谁在场 → 由总管设定（用户不勾选）
  console.log('① 开场：剧情说明谁在屋里……')
  await say(`（场景开场：${A.name}和${B.name}都在屋里；${C.name}在门外，屋里的话他听不见。）`)
  const snapOpening = await ensureScene(
    s => s.present.includes(A.name) && s.present.includes(B.name) && !s.present.includes(C.name),
    [
      `（重申场景：此刻屋里只有${A.name}和${B.name}两个人；${C.name}在门外，听不到屋里。）`,
      `（再次确认场景：屋内=${A.name}、${B.name}；门外=${C.name}，他不在场。）`,
    ],
  )
  assert.ok(
    snapOpening.present.includes(A.name) && snapOpening.present.includes(B.name),
    `总管应判定甲乙在场，实得 ${JSON.stringify(snapOpening.present)}`,
  )
  assert.ok(
    !snapOpening.present.includes(C.name),
    `丙在门外不应算在场，实得 ${JSON.stringify(snapOpening.present)}`,
  )
  console.log(`① 总管判定在场 ✓（在场：${snapOpening.present.join('、')}；不在：${snapOpening.absent.join('、')}）`)

  // ② 当面说出的事：在场的角色自动获知；不在场的**不得被自动登记**
  const F1 = '口令是紫色'
  await say(`（我当众低声说）${F1}。`)
  const f1id = (JSON.parse(readFileSync(join(accDir, '剧情.jsonl'), 'utf8').split('\n').filter(l => l.trim() !== '')
    .filter(l => l.includes('紫色'))[0]) as { id: number }).id
  assert.ok(visibleToOf(f1id).includes(A.name), '消息的可见名单应含在场者甲')
  assert.ok(!visibleToOf(f1id).includes(C.name), '消息的可见名单不得含门外者丙')
  assert.ok(hasAutoEntryFor(A.name, f1id), '在场者甲应被自动登记')
  assert.ok(!hasAutoEntryFor(C.name, f1id), '门外者丙不得被自动登记（机制层保证）')
  const leaked2 = directorEntriesMentioning(C.name, '紫色')
  if (leaked2.length > 0) console.log(`  ⚠ 总管自己给丙写了含该内容的条目（判断层，可用纠正窗口改）：${leaked2.join(' | ')}`)
  console.log('② 在场者被自动登记 / 不在场者不被登记 ✓（快照名单为准）')

  // ③ 剧情里有人进来 → 总管更新在场名单 → 之后的事他才开始知道；进屋之前的事不得被自动登记
  console.log('③ 让丙推门进来……')
  await say(`（剧情：${C.name}推门走了进来。）`)
  const snap3 = await ensureScene(
    s => s.present.includes(C.name),
    [
      `（${C.name}已经进屋，站在我们旁边。屋里现在有三个人。）`,
      `（确认场景：现在屋内=${A.name}、${B.name}、${C.name}，三人都在场。）`,
    ],
  )
  assert.ok(snap3.present.includes(C.name), `总管应把丙计入在场，实得 ${JSON.stringify(snap3.present)}`)

  await say(`（我当众说）口令又改成了青色。`)
  const f2id = (JSON.parse(readFileSync(join(accDir, '剧情.jsonl'), 'utf8').split('\n').filter(l => l.trim() !== '')
    .filter(l => l.includes('青色'))[0]) as { id: number }).id
  assert.ok(hasAutoEntryFor(C.name, f2id), '丙进屋后的事应被自动登记给他')
  assert.ok(!hasAutoEntryFor(C.name, f1id), '丙屋里那件旧事（他不在场时说的）不得被自动登记给他')
  const leaked3 = directorEntriesMentioning(C.name, '紫色')
  if (leaked3.length > 0) console.log(`  ⚠ 总管自己给丙写了含旧口令的条目（判断层）：${leaked3.join(' | ')}`)
  console.log('③ 中途入场：只对进场之后的事件自动登记 ✓')

  // ④ 感知障碍：乙失聪（直接改文件，验证"手改即生效"），此后不再被自动登记
  setStatus(B.name, { 感知: '失聪' })
  await say('（我当众说）口令最终是黑色。')
  const f3id = (JSON.parse(readFileSync(join(accDir, '剧情.jsonl'), 'utf8').split('\n').filter(l => l.trim() !== '')
    .filter(l => l.includes('黑色'))[0]) as { id: number }).id
  assert.ok(hasAutoEntryFor(A.name, f3id), '正常在场者甲应被自动登记')
  assert.ok(!visibleToOf(f3id).includes(B.name), '失聪者的可见名单里不应有这条消息')
  assert.ok(!hasAutoEntryFor(B.name, f3id), '失聪者即使在场也不得被自动登记（机制层保证）')
  const leaked4 = directorEntriesMentioning(B.name, '黑色')
  if (leaked4.length > 0) console.log(`  ⚠ 总管自己给失聪者写了含该内容的条目（判断层）：${leaked4.join(' | ')}`)
  console.log('④ 感知障碍（失聪）排除自动登记 ✓')

  // ⑤ 远程接入：不在现场但能发言；知情走总管的通道记录，不走自动登记
  console.log('⑤ 让丙到院子里打电话进来……')
  await say(`（剧情：${C.name}走到院子外面，掏出手机给屋里打来电话。他人不在屋里，但电话接通着：我们说话他能听见，他说话我们也能听见。）`)
  const snap5 = await ensureScene(
    s => !s.present.includes(C.name) && s.remote.some(l => l.character === C.name && l.perceive === '语音'),
    [
      `（重申场景：${C.name}人已经在院子里，不在屋里；但他正拿着手机和屋里通话中。）`,
      `（再次确认：屋里=${A.name}、${B.name}；${C.name}在院子外面，通过电话实时接进来。）`,
    ],
  )
  assert.ok(!snap5.present.includes(C.name), `打电话的人不在现场，实得现场 ${JSON.stringify(snap5.present)}`)
  const link5 = snap5.remote.find(l => l.character === C.name)
  assert.ok(link5 !== undefined, `总管应把丙记为接入者，实得 ${JSON.stringify(snap5.remote)}`)
  assert.equal(link5!.perceive, '语音', '手机通话应判为语音通道（只有声音）')
  console.log(`⑤ 总管判定接入 ✓（现场：${snap5.present.join('、')}；接入：${link5!.character}·${link5!.note ?? '远程'}·${link5!.perceive}）`)

  const spokeOnPhone = await untilSpeaks(C.name, [
    `（我对着电话问${C.name}：你听得见我说话吗？请他直接回答一句。）`,
    `（${C.name}在电话那头回答了。让${C.name}说话。）`,
  ])
  assert.ok(spokeOnPhone, '远程接入者应能发言（通道那头能说话）')

  await say(`（我对着电话说）口令最后定成金色。`)
  const f4id = (lines().find(l => l.type === 'msg' && (l.text ?? '').includes('金色')) as { id: number }).id
  assert.ok(!visibleToOf(f4id).includes(C.name), '接入者不在自动登记范围（机制层：不在可见名单）')
  assert.ok(!hasAutoEntryFor(C.name, f4id), '接入者不被自动登记（机制层保证）')
  let told = memoryText(C.name).includes('金色')
  for (const cue of [`（电话那头${C.name}说没听清，我又对着电话慢慢说了一遍：测试口令。）`, `（我贴着电话大声说：测试口令——逐字。）`]) {
    if (told) break
    await say(cue)
    told = memoryText(C.name).includes('金色')
  }
  assert.ok(told, '总管应把丙经电话听到的内容显式记给他（记忆里应出现）')
  console.log('⑤ 接入者能发言 / 不自动登记 / 总管按通道记录其知情 ✓')

  // ⑥ rebuild 后场景人员一致（presence 行是事实源）
  const snapFinal = await snapshot()
  server.kill()
  const rb = spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('scripts', 'rebuild.ts'), accGroup], {
    cwd: config.root, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(rb.status, 0, `rebuild 失败: ${rb.stderr?.slice(-200)}`)
  assert.ok(existsSync(presencePath(accDir)), 'rebuild 必须重写 在场.yaml')
  const scene = loadScene(accDir)
  assert.deepEqual([...scene.present].sort(), [...snapFinal.present].sort(), 'rebuild 后的现场名单必须与日志一致')
  assert.deepEqual(
    scene.remote.map(l => l.character).sort(),
    snapFinal.remote.map(l => l.character).sort(),
    'rebuild 后的接入名单必须与日志一致',
  )
  console.log('⑥ rebuild 场景人员一致 ✓')
  console.log('场景人员验收通过：总管判断 / 现场隔离 / 中途入场 / 感知障碍 / 远程接入 / 可重建 ✓')
} finally {
  server.kill()
  cleanup()
}
