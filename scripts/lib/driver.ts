/**
 * 群聊 CLI 测试驱动：spawn 一个群聊进程，逐条喂输入。
 * 回合边界用 CLI 的确定性标记 [[TURN_DONE]]（CLI_TURN_MARKER=1）判定，
 * 不再依赖"输出静默"猜测——思考模式下回复前静默可达十几秒，猜不准。
 * 供 acceptance-m1 / m2 / m3 复用。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { config } from '../../src/config.ts'

const MARK = '[[TURN_DONE]]'

export interface DriveOptions {
  extraEnv?: Record<string, string>
  timeoutMs?: number
}

export async function driveGroup(groupName: string, inputs: string[], opts: DriveOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 1_800_000
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(
      process.execPath,
      [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'group-cli.ts'), groupName],
      {
        cwd: config.root,
        env: { ...process.env, ...opts.extraEnv, CLI_TURN_MARKER: '1' },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      },
    )
    let out = ''
    let started = false
    let fed = 0
    let quitSent = false
    let settled = false
    const marks = (): number => out.split(MARK).length - 1
    const done = (err: Error | null): void => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timer)
      err !== null ? reject(err) : resolve(out)
    }
    child.stdout!.on('data', (d: Buffer) => { out += d.toString('utf8') })
    const timer = setTimeout(() => {
      child.kill()
      done(new Error(`drive 超时（已喂 ${fed}/${inputs.length}，完成 ${marks()} 轮），输出尾部: ${out.slice(-400)}`))
    }, timeoutMs)
    child.on('exit', () => done(null))
    const poll = setInterval(() => {
      if (!started) {
        if (out.includes('已重放')) {
          started = true
          child.stdin!.write(`${inputs[fed++]}\n`)
        }
        return
      }
      if (marks() < fed) return // 当前回合未结束：等待标记
      if (fed < inputs.length) {
        child.stdin!.write(`${inputs[fed++]}\n`)
      } else if (!quitSent) {
        quitSent = true
        child.stdin!.write('/quit\n')
        child.stdin!.end()
      }
    }, 300)
  })
}
