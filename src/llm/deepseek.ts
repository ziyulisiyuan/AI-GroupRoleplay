/**
 * LLM 调用层：官方 openai SDK（OpenAI 兼容协议；DeepSeek 只需换 baseURL）。
 * SDK 负责 SSE 解析与连接级重试；本项目只关心：
 * - reasoning_effort 直传（DeepSeek 扩展字段，SDK 会原样进请求体）
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
}

const clients = new Map<string, OpenAI>()
function client(t: LlmTarget): OpenAI {
  if (t.apiKey === '') throw new Error('未配置模型密钥：请在界面「模型」里添加提供方，或设置 DEEPSEEK_API_KEY')
  const key = `${t.baseUrl}|${t.apiKey}`
  let c = clients.get(key)
  if (c === undefined) {
    c = new OpenAI({ apiKey: t.apiKey, baseURL: t.baseUrl, maxRetries: 2 })
    clients.set(key, c)
  }
  return c
}

type CreateArgs = Parameters<OpenAI['chat']['completions']['create']>[0] & Record<string, unknown>
interface StreamChunk { choices?: Array<{ delta?: { content?: string } }> }
interface NonStreamResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>
    }
  }>
}

function params(model: string, messages: ChatMessage[], extra: { reasoningEffort?: string; temperature?: number }): Record<string, unknown> {
  return {
    model,
    messages,
    // 显式上限：API 默认额度会被深度思考占用，思考烧完额度时可见输出为空（"正在输出却无内容"）
    ...(config.outputMaxTokens > 0 ? { max_tokens: config.outputMaxTokens } : {}),
    ...(extra.reasoningEffort === undefined ? {} : { reasoning_effort: extra.reasoningEffort }),
    ...(extra.temperature === undefined ? {} : { temperature: extra.temperature }),
  }
}

export async function* streamChat(target: LlmTarget, opts: {
  messages: ChatMessage[]
  temperature?: number
  signal?: AbortSignal
}): AsyncGenerator<string> {
  const stream = (await client(target).chat.completions.create(
    {
      ...params(target.model, opts.messages, { reasoningEffort: target.reasoningEffort, temperature: opts.temperature }),
      stream: true,
    } as CreateArgs,
    { signal: opts.signal },
  )) as unknown as AsyncIterable<StreamChunk>
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta !== '') yield delta
  }
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
}): Promise<ToolCallResult> {
  const res = (await client(target).chat.completions.create(
    {
      ...params(target.model, opts.messages, { reasoningEffort: target.reasoningEffort, temperature: opts.temperature }),
      tools: opts.tools,
      tool_choice: 'auto',
    } as CreateArgs,
    { signal: opts.signal },
  )) as unknown as NonStreamResponse
  const message = res.choices?.[0]?.message
  const call = message?.tool_calls?.find(c => c.function?.name === opts.expectedFunction)?.function
  if (call !== undefined) return { name: call.name!, arguments: call.arguments ?? '{}' }

  // 兜底：模型把参数直接写在正文里（含 ```json 围栏或裸 JSON 对象）
  const candidate = (message?.content ?? '').trim().match(/\{[\s\S]*\}/)?.[0]
  if (candidate !== undefined) {
    JSON.parse(candidate) // 非法 JSON 交由调用方降级
    return { name: opts.expectedFunction, arguments: candidate }
  }
  throw new Error(`deepseek 未调用 ${opts.expectedFunction}`)
}
