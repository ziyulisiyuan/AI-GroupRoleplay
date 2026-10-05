/**
 * LLM 调用层：官方 openai SDK（OpenAI 兼容协议，提供方自定 baseURL——DeepSeek/OpenRouter/自建网关同构）。
 * SDK 负责 SSE 解析与连接级重试；本项目只关心：
 * - reasoning_effort 直传（思考模型的扩展字段，SDK 原样进请求体；不认识的提供方可能拒收）
 * - 思考内容（reasoning_content）不进剧情，只产出可见文本
 * - 工具调用：思考模式下 tool_choice 只能为 auto（[已验证]），返回后按期望函数校验 + 正文 JSON 兜底
 * 连接信息（baseUrl/apiKey/model/effort）由调用方每轮通过 resolveLlm() 解析传入，故前端改设置即时生效。
 */
import OpenAI from 'openai'
import type { ChatCompletionTool } from 'openai/resources/chat/completions'
import { config } from '../config.ts'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** 连接参数（与 settings.ts 的 ResolvedLlm 同构，避免循环依赖） */
export interface LlmTarget {
  baseUrl: string
  apiKey: string
  model: string
  reasoningEffort?: string
  /** 输出上限（tokens）：>0 显式写死；0/缺省 = 完全不发该字段（上限交给提供方）。 */
  maxTokens?: number
}

const clients = new Map<string, OpenAI>()
function client(t: LlmTarget): OpenAI {
  if (t.apiKey === '') throw new Error('未配置模型密钥：请在界面「模型」里添加提供方，或设置环境变量 LLM_API_KEY')
  const key = `${t.baseUrl}|${t.apiKey}`
  let c = clients.get(key)
  if (c === undefined) {
    c = new OpenAI({ apiKey: t.apiKey, baseURL: t.baseUrl, maxRetries: 2 })
    clients.set(key, c)
  }
  return c
}

type CreateArgs = Parameters<OpenAI['chat']['completions']['create']>[0] & Record<string, unknown>
interface StreamChunk { choices?: Array<{ delta?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string | null }> }
interface NonStreamResponse {
  choices?: Array<{
    finish_reason?: string | null
    message?: {
      content?: string | null
      reasoning_content?: string | null
      reasoning?: string | null
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
    }
  }>
}

/** 一次模型调用的原始材料：只写进「模型调用.jsonl」供人排查，永不进任何提示词/剧情/记忆。 */
export interface LlmTraceEvent {
  /** 思考内容原文（reasoning_content / reasoning 的增量拼接）。 */
  reasoning: string
  /** 可见正文原文（失败时也带上——"没交卷"时要看的就是它）。 */
  output: string
  /** 工具调用参数（确实调了才有）。 */
  tool?: { name: string; arguments: string }
  /** 结束原因：length = 被输出上限截断；tool_calls / stop 等。 */
  finishReason?: string
  error?: string
  elapsedMs: number
}
export type LlmTrace = (e: LlmTraceEvent) => void

function params(model: string, messages: ChatMessage[], extra: { reasoningEffort?: string; temperature?: number; maxTokens?: number }): Record<string, unknown> {
  // 输出上限：提供方级设置优先，缺省回落全局；0 = 完全不发该字段（把上限交给提供方）。
  const cap = extra.maxTokens ?? config.outputMaxTokens
  return {
    model,
    messages,
    ...(cap > 0 ? { max_tokens: cap } : {}),
    // effort=off/空 = 完全不发该字段：不认它的提供方/模型不会因这个多余键被拒
    ...(extra.reasoningEffort === undefined || extra.reasoningEffort === '' || extra.reasoningEffort === 'off' ? {} : { reasoning_effort: extra.reasoningEffort }),
    ...(extra.temperature === undefined ? {} : { temperature: extra.temperature }),
  }
}

export async function* streamChat(target: LlmTarget, opts: {
  messages: ChatMessage[]
  temperature?: number
  signal?: AbortSignal
  /** 思维链侧路（只供人类查看的记录）：思考模型的 reasoning 增量原样回调——
   *  兼容 reasoning_content（DeepSeek）与 reasoning（个别中转）两种字段；缺省不采。 */
  onReasoning?: (delta: string) => void
  /** 结束原因（缺省不采）：length = 被输出上限截断——"空回复"排查靠它。 */
  onFinish?: (reason: string | undefined) => void
  /** 原始材料侧路：只落 模型调用.jsonl（排查用），不参与任何判定。 */
  trace?: LlmTrace
}): AsyncGenerator<string> {
  const t0 = Date.now()
  let reasoning = ''
  let output = ''
  let finish: string | undefined
  let traced = false
  const done = (extra: Partial<LlmTraceEvent> = {}): void => {
    if (traced) return
    traced = true
    opts.trace?.({ reasoning, output, ...(finish === undefined ? {} : { finishReason: finish }), ...extra, elapsedMs: Date.now() - t0 })
  }
  try {
    const stream = (await client(target).chat.completions.create(
      {
        ...params(target.model, opts.messages, { reasoningEffort: target.reasoningEffort, temperature: opts.temperature, maxTokens: target.maxTokens }),
        stream: true,
      } as CreateArgs,
      { signal: opts.signal },
    )) as unknown as AsyncIterable<StreamChunk>
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      const rdelta = delta?.reasoning_content ?? delta?.reasoning
      if (typeof rdelta === 'string' && rdelta !== '') { reasoning += rdelta; opts.onReasoning?.(rdelta) }
      if (typeof delta?.content === 'string' && delta.content !== '') { output += delta.content; yield delta.content }
      if (typeof choice?.finish_reason === 'string') finish = choice.finish_reason
    }
  } catch (e) {
    done({ error: e instanceof Error ? e.message : String(e) })
    throw e
  }
  opts.onFinish?.(finish)
  done()
}

export interface ToolCallResult {
  name: string
  /** 模型产出的原始参数 JSON 字符串。 */
  arguments: string
}

/** 非流式单次 tool-call（总管路由用）。 */
export async function chatToolCall(target: LlmTarget, opts: {
  messages: ChatMessage[]
  tools: ChatCompletionTool[]
  /** 期望被调用的函数名（用于校验返回）。 */
  expectedFunction: string
  temperature?: number
  signal?: AbortSignal
  /** 原始材料侧路：只落 模型调用.jsonl（排查用），不参与任何判定。 */
  trace?: LlmTrace
}): Promise<ToolCallResult> {
  const t0 = Date.now()
  let reasoning = ''
  let output = ''
  let finish: string | undefined
  let traced = false
  const done = (extra: Partial<LlmTraceEvent> = {}): void => {
    if (traced) return
    traced = true
    opts.trace?.({ reasoning, output, ...(finish === undefined ? {} : { finishReason: finish }), ...extra, elapsedMs: Date.now() - t0 })
  }
  try {
    const res = (await client(target).chat.completions.create(
      {
        ...params(target.model, opts.messages, { reasoningEffort: target.reasoningEffort, temperature: opts.temperature, maxTokens: target.maxTokens }),
        tools: opts.tools,
        tool_choice: 'auto',
      } as CreateArgs,
      { signal: opts.signal },
    )) as unknown as NonStreamResponse
    const choice = res.choices?.[0]
    const message = choice?.message
    reasoning = message?.reasoning_content ?? message?.reasoning ?? ''
    output = message?.content ?? ''
    if (typeof choice?.finish_reason === 'string') finish = choice.finish_reason
    const call = message?.tool_calls?.find(c => c.function?.name === opts.expectedFunction)?.function
    if (call !== undefined) {
      done({ tool: { name: call.name ?? opts.expectedFunction, arguments: call.arguments ?? '{}' } })
      return { name: call.name!, arguments: call.arguments ?? '{}' }
    }

    // 兜底：模型把参数直接写在正文里（含 ```json 围栏或裸 JSON 对象）
    const candidate = output.trim().match(/\{[\s\S]*\}/)?.[0]
    if (candidate !== undefined) {
      try { JSON.parse(candidate) } catch (e) { done({ error: e instanceof Error ? e.message : String(e) }); throw e } // 非法 JSON 交由调用方降级
      done({ tool: { name: opts.expectedFunction, arguments: candidate } })
      return { name: opts.expectedFunction, arguments: candidate }
    }
    const err = new Error(`模型未调用 ${opts.expectedFunction}`)
    done({ error: err.message })
    throw err
  } catch (e) {
    done({ error: e instanceof Error ? e.message : String(e) })
    throw e
  }
}
