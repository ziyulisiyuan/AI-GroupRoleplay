/**
 * 探针 C（控制组）：界面上"按序号删记忆"这条路，是否与"按内容删"形成对照。
 * 期望：3 → 撤 → 1 → 重开仍 1 → 重抄仍 1（即 mid 被记进 retract 载荷，回填与重放都尊重它）。
 * 只读验证，不写业务代码；临时夹具结束必删。
 */
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { config } from '../src/config.ts'
import { GroupSession } from '../src/group/engine.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'

const G = '_exp-ctl'
const dir = join(config.groupsDir, G)
const memFile = () => join(dir, '角色', '角色甲', '记忆.jsonl')
const count = (): number => readFileSync(memFile(), 'utf8').split('\n').filter(s => s.trim() !== '').length
const dump = (): string[] => readFileSync(memFile(), 'utf8').split('\n').filter(s => s.trim() !== '').map(s => JSON.parse(s).text)

try {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  buildGroupFixture(dir, { chars: TEST_CAST.slice(0, 1) })
  let s = GroupSession.open(G)
  s.store.append('user', '你', '开场白', ['角色甲'], 'public')
  s = GroupSession.open(G)
  s.store.append('user', '你', '甲啊，口令是红色这件事你要守住', ['角色甲'], 'public')
  s.store.append('user', '你', '再说一遍，口令是红色的口诀你背了吗', ['角色甲'], 'public')
  s = GroupSession.open(G)
  console.log(`起点 ${count()} 条:`, dump().map(t => t.slice(0, 14)).join(' | '))

  // 走 HTTP 层背后的同一个方法：按 index 撤（先撤出带 mid 的那条）
  const entries = s.memoryOf('角色甲')
  const target = entries.find(e => e.mid !== undefined && e.text.includes('口令是红色'))
  if (target === undefined) throw new Error('没找到带 mid 的目标条目，实验无效')
  s.retractMemory('角色甲', target.index)
  console.log(`按序号撤回（该条 mid=${String(target.mid)}）→ 现在 ${count()} 条`)
  const retract = readFileSync(join(dir, '剧情.jsonl'), 'utf8').split('\n').filter(l => l.includes('"retract"'))
  console.log('retract 载荷:', retract.map(l => JSON.parse(l).content).join(' '))

  s = GroupSession.open(G)
  console.log(`重开进程 → ${count()} 条`)
  const rb = spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('scripts', 'rebuild.ts'), G], { cwd: config.root, encoding: 'utf8', windowsHide: true })
  console.log(`rebuild → ${count()} 条  (${rb.stdout?.trim().split('\n').pop()})`)
  console.log(dump().map(t => `   剩: ${t.slice(0, 20)}`).join('\n'))
} finally {
  rmSync(dir, { recursive: true, force: true })
  console.log('清理:', !existsSync(dir))
}
