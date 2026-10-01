/**
 * 思维链记录（只给人看）：角色发言时思考模型的 reasoning 原文逐字落盘，按消息 id 键控。
 * 与 判定.jsonl 同属"只给人看"的产物家族——**永不进入任何角色的上下文/记忆/可见性管线**，
 * 也不进判定.jsonl；与 剧情.jsonl 的重放体系完全正交：rebuild、活账本、回填都不读它。
 * 生命周期：角色发言时追加；重掷按 id 覆盖（旧思维对应的发言已不存在）；删除消息时一并清除；
 * 编辑消息文本时保留（记录的是当初生成那一刻的思考）。
 * 文件：groups/<群>/思维链.jsonl，一行一条 {id, name, round, ts, thinking}（键序固定，确定性）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const thinkingPath = (groupDir: string): string => join(groupDir, '思维链.jsonl')

interface ThinkingLine { id: number; name: string; round: number; ts: string; thinking: string }

function readAll(groupDir: string): ThinkingLine[] {
  const file = thinkingPath(groupDir)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim() !== '')
    .flatMap(l => {
      try {
        const j = JSON.parse(l) as { id?: unknown; name?: unknown; round?: unknown; ts?: unknown; thinking?: unknown }
        if (typeof j.id !== 'number' || typeof j.thinking !== 'string' || j.thinking === '') return [] // 坏行忽略
        return [{
          id: j.id,
          name: typeof j.name === 'string' ? j.name : '',
          round: typeof j.round === 'number' ? j.round : 0,
          ts: typeof j.ts === 'string' ? j.ts : '',
          thinking: j.thinking,
        }]
      } catch { return [] }
    })
}

function writeAll(groupDir: string, lines: ThinkingLine[]): void {
  writeFileSync(
    thinkingPath(groupDir),
    lines.length === 0 ? '' : lines.map(l => JSON.stringify({ id: l.id, name: l.name, round: l.round, ts: l.ts, thinking: l.thinking })).join('\n') + '\n',
    'utf8',
  )
}

/** 记录/覆盖某条消息的思维链（重掷 = 覆盖同 id；空思维链 = 清除记录）。 */
export function recordThinking(groupDir: string, id: number, name: string, round: number, thinking: string): void {
  const lines = readAll(groupDir).filter(l => l.id !== id)
  if (thinking.trim() === '') { writeAll(groupDir, lines); return }
  lines.push({ id, name, round, ts: new Date().toISOString(), thinking })
  writeAll(groupDir, lines)
}

/** 清除某条消息的思维链（删除消息时）。 */
export function removeThinking(groupDir: string, id: number): void {
  const lines = readAll(groupDir)
  if (!lines.some(l => l.id === id)) return
  writeAll(groupDir, lines.filter(l => l.id !== id))
}

/** 读取某条消息的思维链；无记录返回 undefined。 */
export function getThinking(groupDir: string, id: number): string | undefined {
  return readAll(groupDir).find(l => l.id === id)?.thinking
}
