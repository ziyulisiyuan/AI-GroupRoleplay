/**
 * M2 验收（SPEC §6 M2）——五文件模型：
 * ① 进程A：受伤剧情 → 总管记账 → 状态.yaml 出现伤势字段。
 * ② rebuild 幂等：重放两次与增量写出的四个可变文件逐字节一致。
 * ②b 角色.md（用户专属）全程未被改动。
 * ③ 进程B（全新进程）：3 轮闲聊后再问伤势，角色自述带伤（状态不随轮次消退）。
 * 群目录 groups/_acc-m2 由夹具现造，结束（含失败路径）必删。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { driveGroup } from './lib/driver.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'

const accGroup = '_acc-m2'
const accDir = join(config.groupsDir, accGroup)
const charDir = join(accDir, '角色', '角色甲')
const statusFile = join(charDir, '状态.yaml')
const cleanup = (): void => rmSync(accDir, { recursive: true, force: true })

/** 四个可变文件的整体快照（角色.md 不在此列——它必须原封不动）。 */
const snapshotFiles = (): string =>
  ['状态.yaml', '性格.md', '人物关系.md', '记忆.jsonl'].map(f => `${f}\n${readFileSync(join(charDir, f), 'utf8')}`).join('\n=====\n')

const rebuild = (): string => {
  const r = spawnSync(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('scripts', 'rebuild.ts'), accGroup], {
    cwd: config.root, encoding: 'utf8', windowsHide: true,
  })
  assert.equal(r.status, 0, `rebuild 失败: ${r.stderr?.slice(-300)}`)
  return snapshotFiles()
}

try {
  cleanup()
  buildGroupFixture(accDir, { chars: TEST_CAST })
  const roleMdBefore = readFileSync(join(charDir, '角色.md'), 'utf8')

  // ① 进程A：受伤 → 记账
  console.log('进程A：受伤剧情……')
  await driveGroup(accGroup, ['（剧情：我刺伤了角色甲的手臂，伤口很深，血流不止）角色甲，你怎么样？'], { timeoutMs: 600_000 })
  assert.ok(existsSync(statusFile), '记账后必须生成 状态.yaml')
  const statusAfterA = readFileSync(statusFile, 'utf8')
  assert.match(statusAfterA, /伤|血|刀|创/, `状态.yaml 必须记录伤势，实得: ${statusAfterA.slice(0, 300)}`)
  const filesAfterA = snapshotFiles()
  console.log('① 状态.yaml 记录伤势 ✓')

  // ② rebuild 幂等（四文件整体一致）
  assert.equal(rebuild(), filesAfterA, 'rebuild 重放必须与增量写出的四个文件一致')
  assert.equal(rebuild(), filesAfterA, 'rebuild 必须幂等（两次重放一致）')
  console.log('② rebuild 幂等且与增量一致（四文件） ✓')

  // ②b 角色.md 未被触碰
  assert.equal(readFileSync(join(charDir, '角色.md'), 'utf8'), roleMdBefore, '角色.md 必须原封不动（无写入路径）')
  console.log('②b 角色.md 未被触碰 ✓')

  // ③ 进程B：全新进程，隔多轮后询问伤势
  console.log('进程B（全新进程）：隔 3 轮后询问伤势……')
  const out = await driveGroup(accGroup, [
    '我坐下来歇一会儿',
    '角色乙，今天有什么消息',
    '角色丙，你怎么看',
    '角色甲，你手臂的伤现在怎么样了？',
  ])
  const tail = out.slice(out.lastIndexOf('角色甲：'))
  assert.match(tail, /伤|疼|血|臂|绷带|口子/, `隔轮后角色必须自述带伤，实得: ${tail.slice(0, 300)}`)
  console.log(`③ 隔轮伤势记忆 ✓ 回复: ${tail.split('\n')[0].slice(0, 120)}`)
  console.log('M2 验收通过：受伤记账 → 状态持续 → rebuild 幂等 → 角色.md 只读 ✓')
} finally {
  cleanup()
}
