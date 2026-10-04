/**
 * 可用模型发现（OpenAI 兼容 `GET {baseUrl}/models`）。
 * **必须由服务端发起**：浏览器直连会被 CORS 拦下，密钥也不该进入页面作用域；
 * 安卓壳里"服务端"就是手机上的本地服务，同一份代码。
 * 失败抛错（HTTP 层统一 400 + 原因）：支持列表的提供方给出模型 ID，不支持的让用户手填。
 */
import { fetch as undiciFetch } from 'undici'
import { proxyFor } from '../config.ts'

/** 归一化 API 基址：容忍尾斜杠与用户多写的 /v1 后缀（避免拼出 /v1/v1/models）。 */
function apiBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '').replace(/\/v1$/, '')
}

/** 地址比对用的归一化（忽略大小写）：判定"是不是同一个提供方地址"时与 apiBase 同规则。 */
export function normalizeApiBase(baseUrl: string): string {
  return apiBase(baseUrl).toLowerCase()
}

/**
 * discover 请求的密钥来源：显式填写优先；留空**仅当**要查的地址就是当前提供方存地址本身。
 * 存储密钥绝不能发往表单里任意填写的地址——局域网设备或恶意网页都可能构造该请求，
 * 服务端会替它把 Bearer <存储密钥> 发出去（等于把钥匙递给陌生人）。
 */
export function discoverApiKey(baseUrl: string, typed: string, active: { baseUrl: string; apiKey: string }): string {
  if (typed !== '') return typed
  if (active.apiKey === '') throw new Error('获取模型列表需要 API 密钥')
  if (normalizeApiBase(baseUrl) !== normalizeApiBase(active.baseUrl)) {
    throw new Error('API 地址与当前提供方不一致——请填写该地址的 API 密钥')
  }
  return active.apiKey
}

export async function discoverModels(baseUrl: string, apiKey: string, timeoutMs = 15000): Promise<string[]> {
  const url = `${apiBase(baseUrl)}/v1/models`
  let res: Awaited<ReturnType<typeof undiciFetch>>
  try {
    res = await undiciFetch(url, {
      headers: { authorization: `Bearer ${apiKey}` },
      dispatcher: proxyFor(url),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new Error(reason.includes('timed out') || reason.includes('TimeoutError')
      ? '连接超时——检查 API 地址或网络'
      : `连不上 ${url}（${reason}）——检查 API 地址`)
  }
  const text = await res.text()
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new Error(`密钥被拒绝（HTTP ${res.status}）——检查 API 密钥`)
    if (res.status === 404) throw new Error('该提供方没有 /models 列表接口——请手动填写模型 ID')
    throw new Error(`查询失败 HTTP ${res.status}：${text.slice(0, 120)}`)
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { throw new Error('提供方返回的不是 JSON——请手动填写模型 ID') }
  const list = (parsed as { data?: unknown }).data
  if (!Array.isArray(list)) throw new Error('返回格式不认识（缺少 data 列表）——请手动填写模型 ID')
  const ids = [...new Set(list.flatMap(m => {
    const id = (m as { id?: unknown } | null)?.id
    return typeof id === 'string' && id.trim() !== '' ? [id.trim()] : []
  }))]
  if (ids.length === 0) throw new Error('该提供方没有返回任何模型 ID')
  return ids.sort((a, b) => a.localeCompare(b))
}
