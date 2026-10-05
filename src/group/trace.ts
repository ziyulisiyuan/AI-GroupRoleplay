/**
 * 模型调用原始记录（模型调用.jsonl）——只给人排查用：
 * 每次模型调用（角色生成 + 全部后台 tool-call）的思考原文、可见正文、工具参数、结束原因、
 * 错误与耗时逐条落盘。**永不进任何提示词/剧情/记忆，前端也不展示**（与 判定.jsonl 同级的
 * 诊断产物）。排查空回复 / "模型未调用 X" 时先看这个文件。
 * 无界增长防护：超过 CAP 整体滚到 .1（只保留一代），避免手机磁盘被吃光。
 */
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LlmTraceEvent } from '../llm/chat.ts'

const CAP_BYTES = 8 * 1024 * 1024

export function modelTracePath(groupDir: string): string {
  return join(groupDir, '模型调用.jsonl')
}

export function appendModelTrace(groupDir: string, phase: string, e: LlmTraceEvent): void {
  try {
    const p = modelTracePath(groupDir)
    if (existsSync(p) && statSync(p).size > CAP_BYTES) renameSync(p, p + '.1')
    appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), phase, ...e }) + '\n', 'utf8')
  } catch {
    // 记录失败绝不能影响剧情（与 judgeLog / 思维链同策略）
  }
}
