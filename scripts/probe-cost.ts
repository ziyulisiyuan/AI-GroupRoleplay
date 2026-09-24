/**
 * 探针 D：测出总管一次调用到底吃多少、大头在哪。全程本地假端点，零 API 费用。
 * 场景按"最贵的真实情况"造：3 个角色 + 长名单备注 + 6 条上下文 + 全局规则。
 */
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { config } from '../src/config.ts'
import { buildGroupFixture } from './lib/fixture.ts'

const FAKE = 8941, HOST = 8942
const CAP = join(config.root, '.probe-capture.jsonl')
const G = '_xp-size'
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const CAST = [
  { dir: '角色甲', name: '角色甲', personality: '（测试设定：有话直说，别人问什么就答什么，不装傻、不回避、不推说不知道，遇到追问会把前因后果讲完）', appearance: '（测试外观：三十岁上下，短发自带卷，常穿洗旧的灰蓝色外套，右手背有一道旧疤）', relationships: '（测试关系：与角色乙是旧识，与角色丙互相提防）' },
  { dir: '角色乙', name: '角色乙', personality: '（测试设定：谨慎寡言，但被直接问到会如实回答；习惯先确认对方身份再开口，不轻易表态）', appearance: '（测试外观：四十余岁，戴细框眼镜，说话时习惯把袖口理平）', relationships: '（测试关系：受雇于镇长，知道一些不该说的事）' },
  { dir: '角色丙', name: '角色丙', personality: '（测试设定：乐于配合别人的请求，答应了就守口如瓶；性子急，喜欢打断别人把话说完）', appearance: '（测试外观：年轻，个子高，走路很快，随身带一只铜哨）', relationships: '（测试关系：与角色甲互相提防，欠角色乙一个人情）' },
]

let fake: ChildProcess | undefined, host: ChildProcess | undefined
try {
  rmSync(join(config.groupsDir, G), { recursive: true, force: true })
  writeFileSync(CAP, '', 'utf8')
  mkdirSync(join(config.groupsDir, G), { recursive: true })
  buildGroupFixture(join(config.groupsDir, G), {
    era: '（测试用时代背景：近代边陲小镇，电报刚通，夜里十点后街上不许点灯）',
    world: '（测试用世界观：镇子靠走私与渔获过活，镇长掌握全部航线，外人进得来出不去，三年前一场大火烧掉了半个码头，无人提起）',
    tone: '（测试用基调：节奏压得慢，让角色之间互相试探，不急着揭开底牌；每轮最多一处新信息落地）',
    chars: CAST,
  })
  // 全局规则按真实量级写进去（注入总管 + 每个角色）
  writeFileSync(join(config.root, '规则.md'), '（测试用规则）\n' + '不要写成舞台提示，不要替别人说话，不要出现现代词汇，不要用排比句收尾，长段落拆短。\n'.repeat(8), 'utf8')

  const env = { ...process.env, DEEPSEEK_BASE_URL: `http://127.0.0.1:${FAKE}`, DEEPSEEK_API_KEY: 'fake', DEEPSEEK_MODEL: 'fake-model', DEEPSEEK_REASONING_EFFORT: 'high' }
  fake = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('scripts', 'probe-fake-llm.ts'), String(FAKE), CAP], { cwd: config.root, env, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
  await sleep(2500)
  host = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'server.ts')], { cwd: config.root, env: { ...env, HOST_PORT: String(HOST) }, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
  await sleep(4000)

  // 铺 6 轮真实对话（每轮都会各调一次总管/演员），最后一轮作为测量对象
  const LINES = [
    '角色甲，昨晚码头那边到底有没有灯？把时间说清楚。',
    '乙你别插话，先回答：火是从哪间库房起的，谁最后锁的门。',
    '我提醒你们一句，镇长今天下午在收航线的抄本，谁手里有都交出来。',
    '甲，你刚才出去那趟，看见谁从侧门走了？描述一下那个人。',
    '丙，你说你整晚都在哨位上，那第三声哨是谁吹的？',
    '好，现在把你们三个各自知道的拼一拼，先说结论，再说依据。',
  ]
  for (const line of LINES) {
    await fetch(`http://127.0.0.1:${HOST}/api/group/${G}/message`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: line }),
    }).then(async r => { await r.text() })
    await sleep(120)
  }
  await fetch(`http://127.0.0.1:${HOST}/api/group/${G}/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '角色甲，你刚才在门外听见什么了？再说一遍给乙听。' }),
  }).then(async r => { await r.text() })
  await sleep(600)

  const caps = readFileSync(CAP, 'utf8').split('\n').filter(s => s.trim() !== '').map(s => JSON.parse(s) as { kind: string; fullBody: string })
  const d = [...caps].reverse().find(c => c.kind === 'director')
  if (d === undefined) throw new Error('没抓到总管请求')
  const body = JSON.parse(d.fullBody) as { messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string; description: string; parameters: unknown } }>; reasoning_effort?: string; model: string }
  const sys = body.messages.find(m => m.role === 'system')?.content ?? ''
  const usr = body.messages.find(m => m.role === 'user')?.content ?? ''
  const toolsStr = JSON.stringify(body.tools)
  const toolDesc = body.tools[0].function.description.length + JSON.stringify(body.tools[0].function.parameters).length
  const total = d.fullBody.length
  const cjk = (s: string): number => (s.match(/[一-龥]/g) ?? []).length
  const est = (s: string): number => Math.round(cjk(s) + (s.length - cjk(s)) / 3.2)

  console.log('=== 总管一次调用的构成（字符数 / 中文≈1token 粗估）===')
  for (const [name, s] of [['system 短指令', sys], ['user 大 prompt', usr], ['tools schema', toolsStr], ['请求体总计', d.fullBody]] as const) {
    console.log(`  ${name.padEnd(16)} ${String(s.length).padStart(6)} 字符   ≈${String(est(s)).padStart(5)} token`)
  }
  console.log(`\n  其中「工具 schema 的中文说明文字」 ${toolDesc} 字符 ≈${est(toolsStr)} token`)
  console.log(`  prompt 各段行数：system ${sys.split('\n').length} · user ${usr.split('\n').length}`)
  console.log('\n--- user prompt 全文（按段标注）---')
  console.log(usr)
  console.log('\n--- 演员一次调用（对照，取最后一轮）---')
  const c = [...caps].reverse().find(x => x.kind === 'character')
  if (c !== undefined) {
    console.log(`  请求体 ${c.fullBody.length} 字符 ≈${est(c.fullBody)} token`)
    console.log('  注意：按 docs/FINDINGS-2026-09-21.md I-1，演员的人设段根本没进请求，所以这不是"修好之后"的量级')
  }
  const dsum = caps.filter(x => x.kind === 'director').reduce((a, x) => a + x.fullBody.length, 0)
  const csum = caps.filter(x => x.kind === 'character').reduce((a, x) => a + x.fullBody.length, 0)
  console.log(`\n  7 轮合计：总管 ${dsum} 字符 vs 演员 ${csum} 字符 → 总管占输入总量的 ${(dsum / (dsum + csum) * 100).toFixed(0)}%`)
} finally {
  host?.kill(); fake?.kill()
  await sleep(400)
  rmSync(join(config.groupsDir, G), { recursive: true, force: true })
  rmSync(CAP, { force: true })
  const rp = join(config.root, '规则.md')
  if (existsSync(rp)) rmSync(rp, { force: true })
  console.log('\n清理:', !existsSync(join(config.groupsDir, G)) && !existsSync(CAP))
}
