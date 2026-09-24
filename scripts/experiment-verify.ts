/**
 * 临时探针（验证三条争议行为，全程离线不碰 LLM）。用完即删。
 * E1 记忆按文本撤回：实时路径 vs rebuild 重放路径是否一致
 * E2 消息被改/删后，已入账的"亲历"摘要是否还带旧文本
 * E3 引擎是否真的从不发 ledger 事件
 */
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { config } from '../src/config.ts'
import { GroupSession } from '../src/group/engine.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'
import { loadFiles } from '../src/group/status.ts'
import { buildMemory } from '../src/group/knowledge.ts'
import { assembleGroup } from '../src/group/host.ts'
import { StoryStore } from '../src/store.ts'

const G = '_exp-probe'
const dir = join(config.groupsDir, G)
const cleanup = (): void => rmSync(dir, { recursive: true, force: true })
const memFile = join(dir, '角色', '角色甲', '记忆.jsonl')
const memCount = (): number => readFileSync(memFile, 'utf8').split('\n').filter(s => s.trim() !== '').length

function e1(): void {
  console.log('\n=== E1 按文本撤回：实时 vs rebuild 重放 ===')
  cleanup()
  mkdirSync(dir, { recursive: true })
  buildGroupFixture(dir, { chars: TEST_CAST.slice(0, 1) })

  let s = GroupSession.open(G)
  s.store.append('user', '你', '开场白', ['角色甲'], 'public')
  s = GroupSession.open(G) // 触发回填
  s.store.append('user', '你', '甲啊，口令是红色这件事你要守住', ['角色甲'], 'public')
  s.store.append('user', '你', '再说一遍，口令是红色的口诀你背了吗', ['角色甲'], 'public')
  s = GroupSession.open(G)
  console.log(`撤回前磁盘记忆 ${memCount()} 条`)

  const removed = s.retractKnowledge('角色甲', { text: '口令是红色' })
  console.log(`实时路径按文本"口令是红色"撤回 → 命中 ${removed} 条`)
  console.log(`撤回后磁盘记忆 ${memCount()} 条`)
  const ledger = readFileSync(join(dir, '剧情.jsonl'), 'utf8').split('\n').filter(l => l.includes('"retract"'))
  console.log(`落盘的 retract 行: ${ledger.map(l => JSON.parse(l).content).join(' ')}`)

  const s3 = GroupSession.open(G) // 等价于"重启 Host 进程"
  console.log(`重开进程回填后记忆 ${memCount()} 条（磁盘）/ ${s3.memoryOf('角色甲').length} 条（内存）`)

  const rb = spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('scripts', 'rebuild.ts'), G], {
    cwd: config.root, encoding: 'utf8', windowsHide: true,
  })
  console.log(`rebuild 输出: ${rb.stdout?.trim().split('\n').pop()}`)
  const after = loadFiles(join(dir, '角色', '角色甲')).memory
  console.log(`rebuild 后磁盘记忆 ${memCount()} 条 / 解析 ${after.length} 条`)
  console.log(removed > 0 && after.length > 0
    ? `>>> 分歧：实时删了 ${removed} 条，重放又放回来 ${after.length} 条 ❌`
    : (removed > 0 ? '>>> 实时与重放一致（都已清空）✅' : '>>> 未命中，实验无效'))
}

function e2(): void {
  console.log('\n=== E2 改/删消息后，已入账的"亲历"摘要还带旧文本吗 ===')
  cleanup()
  mkdirSync(dir, { recursive: true })
  buildGroupFixture(dir, { chars: TEST_CAST.slice(0, 1) })
  let s = GroupSession.open(G)
  const key = s.store.append('user', '你', '甲记住：口令是红色，别告诉乙', ['角色甲'], 'public')
  s = GroupSession.open(G)
  // 再堆 14 条公开消息，把 key 挤出"最近 12 条"窗口
  for (let i = 1; i <= 14; i++) s.store.append('user', '你', `闲话第${i}句`, ['角色甲'], 'public')
  s = GroupSession.open(G)
  s.editMessage(key.id, '甲记住：口令是蓝色，别告诉乙')
  const store = s.store
  const files = loadFiles(join(dir, '角色', '角色甲'))
  const injected = buildMemory(store, '角色甲', files.memory)
  const staleInMemory = /红色/.test(injected)
  const freshInWindow = /蓝色/.test(injected)
  console.log(`改口径 红→蓝 后注入的记忆片段里：含"红色"=${staleInMemory} 含"蓝色"=${freshInWindow}`)
  console.log(injected.split('\n').filter(l => /红色|蓝色/.test(l)).map(l => `   ${l.slice(0, 90)}`).join('\n'))

  const { system, messages } = assembleGroup(
    s.characters[0], s.settings, store.effectiveMessages(),
    { files, memoryText: injected, presentNames: ['角色甲'] },
  )
  const seesOld = /红色/.test(system + JSON.stringify(messages))
  console.log(`>>> 角色本轮输入里是否仍出现旧口径"红色"：${seesOld ? '是 ❌（改口径在 12 条窗口外不生效）' : '否 ✅'}`)

  // 删掉那条消息，看记忆里是否还留着它的内容
  s.deleteMessage(key.id)
  const files2 = loadFiles(join(dir, '角色', '角色甲'))
  const inj2 = buildMemory(s.store, '角色甲', files2.memory)
  const goneFromView = !s.store.effectiveMessages().some(m => m.id === key.id)
  console.log(`删除后：可见视图已无该消息=${goneFromView} · 记忆片段仍含"红色"=${/红色/.test(inj2)}`)
  console.log('    （删除只移出视图、记忆另有撤回通道 → 这一条是设计）')
}

function e3(): void {
  console.log('\n=== E3 引擎发出的事件类型 ===')
  const src = readFileSync(join(config.root, 'src', 'group', 'engine.ts'), 'utf8')
  const emitted = [...src.matchAll(/yield \{ type: '(\w+)'/g)].map(m => m[1])
  const declared = [...src.matchAll(/\| \{ type: '(\w+)'/g)].map(m => m[1])
  const uniq = [...new Set(declared)]
  console.log(`SessionEvent 声明: ${uniq.join(' ')}`)
  console.log(`engine 实际 yield: ${[...new Set(emitted)].join(' ')}`)
  const never = uniq.filter(t => !emitted.includes(t))
  console.log(`从不发出的事件类型: ${never.join(' ') || '（无）'}`)
}

try {
  e1(); e2(); e3()
} finally {
  cleanup()
  console.log(`\n探针夹具已删除: ${!existsSync(dir)}`)
}
