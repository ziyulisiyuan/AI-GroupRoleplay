/**
 * M1 验收（SPEC §6 M1）：
 * ① 降级生效：DIRECTOR_TIMEOUT_MS=1 时总管必超时，route 行必须 fallback=true，且提及检测仍能命中。
 * ② 10 轮群聊：点名轮（全名）正确角色接话 ≥6/7；route 行逐轮落盘。
 * 群目录 groups/_acc-m1 由夹具现造，结束（含失败路径）必删。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { driveGroup } from './lib/driver.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'

const accGroup = '_acc-m1'
const accDir = join(config.groupsDir, accGroup)
const cleanup = (): void => rmSync(accDir, { recursive: true, force: true })

interface RouteLine { type: 'route'; round: number; picked: string; reason: string; fallback: boolean }

function readRoutes(): RouteLine[] {
  const p = join(accDir, '剧情.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as RouteLine).filter(l => l.type === 'route')
}

try {
  cleanup()
  buildGroupFixture(accDir, { chars: TEST_CAST })

  // ① 降级生效
  await driveGroup(accGroup, ['角色甲，在吗'], { extraEnv: { DIRECTOR_TIMEOUT_MS: '1' }, timeoutMs: 240_000 })
  const fbRoutes = readRoutes()
  assert.ok(fbRoutes.length >= 1, '降级轮必须产生 route 行')
  assert.ok(fbRoutes.every(r => r.fallback), `超时路由必须标记降级: ${JSON.stringify(fbRoutes)}`)
  assert.equal(fbRoutes[0].picked, '角色甲', '降级时提及检测仍应命中')
  console.log('① 降级生效 ✓（超时→fallback，提及检测兜底命中）')

  // ② 10 轮群聊：点名准确率
  rmSync(join(accDir, '剧情.jsonl'), { force: true })
  const turns: Array<[string, string | null]> = [
    ['角色甲，说说你的看法', '角色甲'],
    ['角色乙也在吗？帮我看看这个', '角色乙'],
    ['角色丙，你怎么想', '角色丙'],
    ['大家觉得这件事该怎么办？', null],
    ['角色甲，再补充两句', '角色甲'],
    ['角色丙，说说你的判断', '角色丙'],
    ['角色乙，这件事交给你了', '角色乙'],
    ['接下来会怎么样？', null],
    ['角色甲，收个尾', '角色甲'],
    ['多谢各位', null],
  ]
  await driveGroup(accGroup, turns.map(t => t[0]))
  const routes = readRoutes()
  assert.equal(routes.length, turns.length, `每轮必须有一条 route 行，实得 ${routes.length}/${turns.length}`)

  let mentionHits = 0
  let mentionTotal = 0
  for (let i = 0; i < turns.length; i++) {
    const [text, expected] = turns[i]
    const r = routes[i]
    console.log(`  T${i + 1}: ${r.picked}${r.fallback ? '〔降级〕' : ''}（${r.reason}） ← ${text}`)
    if (expected !== null) {
      mentionTotal++
      if (r.picked === expected) mentionHits++
      else console.log(`  ✗ 期望 ${expected}`)
    }
  }
  console.log(`点名准确率: ${mentionHits}/${mentionTotal}`)
  assert.ok(mentionHits >= mentionTotal - 1, `点名准确率不足: ${mentionHits}/${mentionTotal}`)
  console.log('M1 验收通过：10 轮群聊 + route 落盘 + 超时降级 ✓')
} finally {
  cleanup()
}
