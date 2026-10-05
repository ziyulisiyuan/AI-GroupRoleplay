/**
 * 运行环境配置：全部可被环境变量覆盖；.env（工作区根目录）可选，KEY=VALUE 逐行。

 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProxyAgent } from 'undici'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let dotenvCache: Record<string, string> | undefined

function dotenv(): Record<string, string> {
  if (dotenvCache === undefined) {
    dotenvCache = {}
    const p = resolve(ROOT, '.env')
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
        if (m) dotenvCache[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  }
  return dotenvCache
}

function get(key: string): string | undefined {
  return process.env[key] ?? dotenv()[key]
}

export const config = {
  root: ROOT,
  groupsDir: resolve(ROOT, 'groups'),
  get apiKey(): string {
    // 通用名优先，DEEPSEEK_* 为旧名兼容（settings.yaml 有提供方时本组根本不参与）
    return get('LLM_API_KEY') ?? get('DEEPSEEK_API_KEY') ?? ''
  },
  baseUrl: get('LLM_BASE_URL') ?? get('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com',
  model: get('LLM_MODEL') ?? get('DEEPSEEK_MODEL') ?? 'deepseek-flash',
  /** 思考深度：off | low | high | max（支持 reasoning_effort 的思考模型生效）。 */
  reasoningEffort: get('LLM_REASONING_EFFORT') ?? get('DEEPSEEK_REASONING_EFFORT') ?? 'high',
  /** 总管路由超时（SPEC §4.1 降级触发线）。开思考后路由本身要几秒到十几秒，默认线相应放宽。 */
  directorTimeoutMs: Number(get('DIRECTOR_TIMEOUT_MS') ?? 30000),
  /** 快路径（Jev 路由判断）超时：超时即回退完整总管，别让快路径变成新的等待。 */
  jevTimeoutMs: Number(get('JEV_TIMEOUT_MS') ?? 4000),
  /** 接力累计衰减系数（纯代码，Jev 不可见）：角色发言后紧接的那次判定其概率压 0（不可能连续
   *  发言，该次不推进衰减）；其余每次判定其累计权重乘以该系数——重新发言不重置，衰减叠加贯穿
   *  整轮；用户概率永不衰减，最终把发言权判回用户（接力因此不设硬上限）。 */
  relayDecay: Number(get('RELAY_DECAY') ?? 0.8),
  /** 角色可见的消息窗口条数（assembleGroup 注入 + 记忆注入的去重窗口共用）。 */
  contextWindow: Number(get('CONTEXT_WINDOW') ?? 36),
  /** Jev 快路径的对话窗口条数（Jev 没有输入上限、按输入计费且很便宜，给得比角色窗口宽）。 */
  jevContextWindow: Number(get('JEV_CONTEXT_WINDOW') ?? 75),
  /** 单次输出的 token 上限：>0 显式写死；**0 = 完全不发该字段**（上限交给提供方）。
   *  提供方级 maxTokens 优先，缺省回落这里。 */
  outputMaxTokens: Number(get('LLM_MAX_TOKENS') ?? get('DEEPSEEK_MAX_TOKENS') ?? 0),
  /** 重工具调用（现场所见/事件补全/离场渲染/记账/纠正）的单次等待上限：思考久的模型要更宽的线。 */
  heavyTimeoutMs: Number(get('HEAVY_TIMEOUT_MS') ?? 180000),
  /** 出站代理（Jev/中转用）：环境变量优先，.env 的 HTTPS_PROXY 兜底；空 = 直连。 */
  get proxy(): string {
    return process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
      ?? get('HTTPS_PROXY') ?? get('https_proxy') ?? get('HTTP_PROXY') ?? get('http_proxy') ?? ''
  },
}

/** 本机端点（自检 mock / 本地网关）不走代理；远端按 config.proxy 走。 */
export function proxyFor(url: string): ProxyAgent | undefined {
  if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/)/.test(url)) return undefined
  const proxy = config.proxy
  return proxy === '' ? undefined : new ProxyAgent(proxy)
}
