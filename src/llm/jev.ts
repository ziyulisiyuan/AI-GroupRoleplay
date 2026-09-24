/**
 * Jev（TypeSafe "System One" 结构化决策模型）客户端，SPEC §6.1a 快路径用。
 * 端点：POST {baseUrl}/v1/systemone（原生透传，AIHubMix 中转与官方 api.typesafe.ai 同格式）。
 * 它不生成文本，只回答三种类型化问题：
 *   noul   —— 真假判断（返回 0~1 概率）
 *   choice —— 从 criteria 里选一项（返回选中项 + 置信度 + 全概率分布）
 *   score  —— 按标尺打分（本系统暂未使用）
 * 国内网络经中转通常仍需代理：读 HTTPS_PROXY/https_proxy 环境变量（undici ProxyAgent）。
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { config } from '../config.ts'

export interface JevLlm {
  baseUrl: string
  apiKey: string
  /** 如 jev-latest。 */
  model: string
}

export type JevQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }

export interface JevChoiceAnswer {
  type: 'choice'
  choice: string
  confidence: number
  probabilities: Record<string, number>
}

export interface JevNoulAnswer {
  type: 'noul'
  noul: number
}

export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | { type: 'score'; score: number; confidence: number }

function proxyDispatcher(url: string): ProxyAgent | undefined {
  // 本地端点（自检 mock / 本地网关）不走代理；远端经中转通常需要（环境变量优先，.env 兜底）
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(url)) return undefined
  const proxy = config.proxy
  return proxy === '' ? undefined : new ProxyAgent(proxy)
}

/**
 * 发起一次 Jev 判断。任何失败（网络/超时/HTTP 非 2xx/响应缺 answers）都抛错，
 * 由调用方决定回退——快路径的失败必须静默退到 deepseek 总管，不打断剧情。
 */
export async function jevDecide(opts: {
  llm: JevLlm
  state: string
  questions: Record<string, JevQuestion>
  timeoutMs?: number
}): Promise<Record<string, JevAnswer>> {
  const base = opts.llm.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
  const url = `${base}/v1/systemone`
  const res = await undiciFetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${opts.llm.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: opts.llm.model, state: opts.state, questions: opts.questions }),
    dispatcher: proxyDispatcher(url),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 4000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`jev HTTP ${res.status}: ${text.slice(0, 200)}`)
  const parsed = JSON.parse(text) as { answers?: Record<string, JevAnswer> }
  if (parsed.answers === undefined || typeof parsed.answers !== 'object') throw new Error(`jev 响应缺少 answers: ${text.slice(0, 200)}`)
  return parsed.answers
}
