/**
 * M1/M2 多角色群聊终端——GroupSession 引擎的 CLI 瘦壳。pnpm chat:group <群聊名>
 */
import { createInterface } from 'node:readline'
import { GroupSession, listGroups, type SessionEvent } from './group/engine.ts'
import { healOrphanSettingsBackup } from './settings.ts'

healOrphanSettingsBackup() // 启动自愈：还原被硬崩溃中断的自检留下的 mock 配置

const groupName = process.argv[2]
if (groupName === undefined || groupName === '') {
  const available = listGroups()
  console.error(`用法: pnpm chat:group <群聊名>\n可用群聊: ${available.length > 0 ? available.join('、') : '（无——照 SPEC §3.1 在 groups/ 下建一个）'}`)
  process.exit(1)
}

let session: GroupSession
try {
  session = GroupSession.open(groupName)
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

console.log(
  `群聊 · ${groupName} · 角色：${session.characterNames().join('、') || '（还没有角色）'}\n` +
  `已重放 ${session.snapshot().messages.length} 条历史。/cast 名单 · /roll 重掷 · /status 状态 · /quit 退出`,
)

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })

async function handle(text: string, stream: AsyncGenerator<SessionEvent>): Promise<void> {
  void text
  let sawDelta = false
  for await (const ev of stream) {
    if (ev.type === 'speaker') process.stdout.write(`${ev.name}：`)
    else if (ev.type === 'delta') { sawDelta = true; process.stdout.write(ev.text) }
    else if (ev.type === 'route') console.log(`── ${ev.picked} 接话（${ev.reason}）${ev.fallback ? '〔降级〕' : ''}`)
    else if (ev.type === 'reply') { if (sawDelta) { process.stdout.write('\n'); sawDelta = false } }
    else if (ev.type === 'ledger') console.log(`〔记账〕${ev.text}`)
    else if (ev.type === 'info') console.log(`（${ev.text}）`)
  }
}

let streaming = false
/** 生成中的输入排队而非丢弃（思考模式下回复前静默可能很久，真人也会连续打字）。 */
const pending: string[] = []
/** 供自动化验收判定"本轮结束"的确定性标记（CLI_TURN_MARKER=1 时输出）。 */
const TURN_MARKER = process.env.CLI_TURN_MARKER === '1'

function startTurn(text: string): void {
  streaming = true
  let gen: AsyncGenerator<SessionEvent>
  if (text === '/roll') gen = session.roll()
  else gen = session.speak(text)

  void handle(text, gen)
    .catch(err => console.error(`[出错] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`))
    .finally(() => {
      streaming = false
      if (TURN_MARKER) process.stdout.write('\n[[TURN_DONE]]\n')
      const next = pending.shift()
      if (next !== undefined) startTurn(next)
    })
}

rl.on('line', line => {
  const text = line.trim()
  if (text === '') return
  if (text === '/quit') { rl.close(); process.exit(0) }
  if (streaming) { pending.push(text); return }
  if (text === '/new') {
    // 引擎不暴露 reset（M0 CLI 专用）；群聊重建走文件级操作
    console.log('（/new 请直接删除 groups 下的 剧情.jsonl 后重启）')
    return
  }
  if (text === '/cast') { console.log(session.characterNames().map(n => `- ${n}`).join('\n')); return }
  if (text === '/status') { console.log(session.statusLines().join('\n')); return }
  startTurn(text)
})
