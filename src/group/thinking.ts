/**
 * 思维链记录（只给人看）：角色发言时思考模型的 reasoning 原文逐字落盘，按消息 id + 阶段键控。
 * 一次角色输出最多两段思考：
 *   循环前 —— 生成草稿时的思考（中间判定之前）；
 *   循环后 —— 判定命中、按改稿要求重写时的思考（没有命中就没有这一段）。
 * 与 判定.jsonl 同属"只给人看"的产物家族——**永不进入任何角色的上下文/记忆/可见性管线**，
 * 也不进 判定.jsonl；与 剧情.jsonl 的重放体系完全正交：rebuild、活账本、回填都不读它。
 * 生命周期：角色发言时按 id 覆盖两段（重掷 = 重新覆盖；空串 = 清除该段）；删除消息时一并清除；
 * 编辑消息文本时保留（记录的是当初生成那一刻的思考）。
 * 文件：groups/<群>/思维链.jsonl，一行一条 {id, name, round, ts, stage, thinking}（键序固定，确定性）。
 * 旧数据没有 stage 字段 —— 一律按「循环前」读（兼容，不需要迁移）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type ThinkingStage = '循环前' | '循环后'

export const thinkingPath = (groupDir: string): string => join(groupDir, '思维链.jsonl')

interface ThinkingLine { id: number; name: string; round: number; ts: string; stage: ThinkingStage; thinking: string }

function readAll(groupDir: string): ThinkingLine[] {
  const file = thinkingPath(groupDir)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .flatMap(l => {
      try {
        const j = JSON.parse(l) as { id?: unknown; name?: unknown; round?: unknown; ts?: unknown; stage?: unknown; thinking?: unknown }
        if (typeof j.id !== 'number' || typeof j.thinking !== 'string' || j.thinking === '') return [] // 坏行忽略
        return [{
          id: j.id,
          name: typeof j.name === 'string' ? j.name : '',
          round: typeof j.round === 'number' ? j.round : 0,
          ts: typeof j.ts === 'string' ? j.ts : '',
          stage: j.stage === '循环后' ? '循环后' as const : '循环前' as const,
          thinking: j.thinking,
        }]
      } catch { return [] }
    })
}

function writeAll(groupDir: string, lines: ThinkingLine[]): void {
  writeFileSync(
    thinkingPath(groupDir),
    lines.length === 0 ? '' : lines.map(l => JSON.stringify({ id: l.id, name: l.name, round: l.round, ts: l.ts, stage: l.stage, thinking: l.thinking })).join('\n') + '\n',
    'utf8',
  )
}

/** 记录/覆盖某条消息的两段思维链（重掷 = 两段一起覆盖；空串 = 清除该段）。 */
export function recordThinking(groupDir: string, id: number, name: string, round: number, before: string, after = ''): void {
  const lines = readAll(groupDir).filter(l => l.id !== id)
  const ts = new Date().toISOString()
  if (before.trim() !== '') lines.push({ id, name, round, ts, stage: '循环前', thinking: before })
  if (after.trim() !== '') lines.push({ id, name, round, ts, stage: '循环后', thinking: after })
  writeAll(groupDir, lines)
}

/** 清除某条消息的思维链（删除消息时，两段一起清）。 */
export function removeThinking(groupDir: string, id: number): void {
  const lines = readAll(groupDir)
  if (!lines.some(l => l.id === id)) return
  writeAll(groupDir, lines.filter(l => l.id !== id))
}

/** 读取某条消息某一段的思维链；无记录返回 undefined。缺省 = 循环前（旧数据只有这一段）。 */
export function getThinking(groupDir: string, id: number, stage: ThinkingStage = '循环前'): string | undefined {
  return readAll(groupDir).find(l => l.id === id && l.stage === stage)?.thinking
}

/** 有「循环后」思维链的消息 id（前端据此决定长按菜单里要不要给这一项）。 */
export function listThinkingAfterIds(groupDir: string): number[] {
  return [...new Set(readAll(groupDir).filter(l => l.stage === '循环后').map(l => l.id))].sort((a, b) => a - b)
}

/** 清空全部思维链记录（清空聊天记录时——每条思维链都属于某条消息）。 */
export function clearThinking(groupDir: string): void {
  writeAll(groupDir, [])
}
