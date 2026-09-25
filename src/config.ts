/**
 * 运行环境配置：全部可被环境变量覆盖；.env（工作区根目录）可选，KEY=VALUE 逐行。
 * SPEC §2：DeepSeek 优先；M0 角色直连，M1 起总管走 dsh runtime。
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    return get('DEEPSEEK_API_KEY') ?? ''
  },
  baseUrl: get('DEEPSEEK_BASE_URL') ?? 'https://api.deepseek.com',
  model: get('DEEPSEEK_MODEL') ?? 'deepseek-flash',
  /** 思考深度：off | low | high | max（deepseek-flash/deepseek-reasoner 生效）。 */
  reasoningEffort: get('DEEPSEEK_REASONING_EFFORT') ?? 'high',
  /** 总管路由超时（SPEC §4.1 降级触发线）。开思考后路由本身要几秒到十几秒，默认线相应放宽。 */
  directorTimeoutMs: Number(get('DIRECTOR_TIMEOUT_MS') ?? 30000),
  /** 快路径（Jev 路由判断）超时：超时即回退 deepseek 完整总管，别让快路径变成新的等待。 */
  jevTimeoutMs: Number(get('JEV_TIMEOUT_MS') ?? 4000),
  /** 接力累计衰减系数（纯代码，Jev 不可见）：角色发言后紧接的那次判定其概率压 0（不可能连续
   *  发言，该次不推进衰减）；其余每次判定其累计权重乘以该系数——重新发言不重置，衰减叠加贯穿
   *  整轮；用户概率永不衰减，最终把发言权判回用户（接力因此不设硬上限）。 */
  relayDecay: Number(get('RELAY_DECAY') ?? 0.8),
  /** 角色可见的消息窗口条数（assembleGroup 注入 + 记忆注入的去重窗口共用）。 */
  contextWindow: Number(get('CONTEXT_WINDOW') ?? 36),
  /** 单次生成的 token 上限：不显式设高时，API 默认额度会被深度思考分走，
   *  出现"状态栏显示正在输出、最后却什么内容都没有"——思考烧完额度，可见输出为空。 */
  outputMaxTokens: Number(get('DEEPSEEK_MAX_TOKENS') ?? 8192),
  /** 出站代理（Jev/中转用）：环境变量优先，.env 的 HTTPS_PROXY 兜底；空 = 直连。 */
  get proxy(): string {
    return process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
      ?? get('HTTPS_PROXY') ?? get('https_proxy') ?? get('HTTP_PROXY') ?? get('http_proxy') ?? ''
  },
}
