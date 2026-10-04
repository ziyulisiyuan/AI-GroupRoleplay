/**
 * 模型发现 + 思考档位的离线自检（无需 API key、不联网）：全部打在本地 mock HTTP 服务上。
 * 1) discoverModels：GET {baseUrl}/v1/models（baseUrl 带不带 /v1、尾斜杠都能拼对）、Bearer 鉴权、
 *    去重 + 排序、只认字符串 id；
 * 2) 错误路径：401/403（密钥）、404（无列表接口）、非 JSON、缺 data、空列表——各自给出可读原因，
 *    让用户知道该换密钥还是该手填；
 * 3) 思考档位：off = 请求体里**没有** reasoning_effort（不认该字段的提供方不会被拒），
 *    其余档位原样直传。这是"模型可能没有这个档位"的兜底语义，值得钉住。
 */
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { streamChat } from '../src/llm/chat.ts'
import { discoverApiKey, discoverModels } from '../src/llm/discover.ts'

const seen: Array<{ path: string; auth: string | undefined; body: string }> = []
/** mock 提供方：?tag=scenario-401 之类决定 /v1/models 的应答形态（GET 无请求体，标记走 query）。 */
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = ''
  req.on('data', c => { body += String(c) })
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    seen.push({ path: url.pathname, auth: req.headers.authorization, body })
    const send = (code: number, text: string): void => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(text) }
    if (url.pathname.endsWith('/v1/models')) {
      switch (url.pathname.split('/')[1]) {
        case 'scenario-401': return send(401, '{"error":"bad key"}')
        case 'scenario-404': return send(404, 'not found')
        case 'scenario-html': return send(200, '<html>hi</html>')
        case 'scenario-nodata': return send(200, '{"object":"list"}')
        case 'scenario-empty': return send(200, '{"data":[]}')
        // 正常：乱序 + 重复 + 非字符串/空 id（都必须被剔掉）
        default: return send(200, JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'b-model' }, { id: '' }, { notId: 1 }] }))
      }
    }
    if (url.pathname === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    send(404, 'nope')
  })
})

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

try {
  // 1) 正常路径：地址四种写法都拼到 /v1/models，结果去重且有序
  for (const raw of [base, `${base}/`, `${base}/v1`, `${base}/v1/`]) {
    seen.length = 0
    const models = await discoverModels(raw, 'key-1')
    assert.deepEqual(models, ['a-model', 'b-model'], `去重 + 排序（baseUrl=${raw}）`)
    assert.ok(seen[0]?.path.endsWith('/v1/models'), `拼接结果（baseUrl=${raw} → ${seen[0]?.path}）`)
    assert.equal(seen[0]?.auth, 'Bearer key-1', '带 Bearer 鉴权')
  }

  // 2) 错误路径：原因必须可读（用户据此决定换密钥还是手填）
  const cases: Array<[string, RegExp]> = [
    ['scenario-401', /密钥被拒绝/],
    ['scenario-404', /没有 \/models 列表接口/],
    ['scenario-html', /不是 JSON/],
    ['scenario-nodata', /缺少 data 列表/],
    ['scenario-empty', /没有返回任何模型 ID/],
  ]
  for (const [tag, re] of cases) {
    await assert.rejects(
      () => discoverModels(`${base}/${tag}`, 'key-1'),
      (e: Error) => { assert.match(e.message, re, tag); return true },
    )
  }

  // 3) 思考档位：off 不发该字段；high 原样直传
  const bodyOf = (): Record<string, unknown> => JSON.parse(seen.filter(s => s.path === '/v1/chat/completions').at(-1)?.body ?? '{}') as Record<string, unknown>
  for await (const _ of streamChat({ baseUrl: `${base}/v1`, apiKey: 'k', model: 'm', reasoningEffort: 'off' }, { messages: [{ role: 'user', content: 'hi' }] })) { /* 读干流 */ }
  assert.equal('reasoning_effort' in bodyOf(), false, 'off = 请求体不得含 reasoning_effort')
  for await (const _ of streamChat({ baseUrl: `${base}/v1`, apiKey: 'k', model: 'm', reasoningEffort: 'high' }, { messages: [{ role: 'user', content: 'hi' }] })) { /* 读干流 */ }
  assert.equal(bodyOf()['reasoning_effort'], 'high', '非 off 档位原样直传')

  // 4) 密钥来源守卫：留空复用已存密钥，仅限"要查的地址 == 当前提供方存地址"；
  //    存储密钥绝不发往表单里任意填写的地址（局域网设备/恶意网页都可能构造该请求）。
  const active = { baseUrl: 'http://provider.example:9000/v1', apiKey: 'stored-key' }
  assert.equal(discoverApiKey('http://Provider.Example:9000/v1/', '', active), 'stored-key', '同一地址（大小写/尾斜杠/尾 /v1 差异）可复用已存密钥')
  assert.throws(() => discoverApiKey('http://attacker.example:9999', '', active), /请填写该地址的 API 密钥/, '地址不一致：不得复用已存密钥（防外泄）')
  assert.equal(discoverApiKey('http://attacker.example:9999', 'typed-key', active), 'typed-key', '显式填写的密钥原样使用')
  assert.throws(() => discoverApiKey('http://provider.example:9000', '', { baseUrl: 'http://provider.example:9000', apiKey: '' }), /需要 API 密钥/, '无已存密钥且留空：明确报错')

  console.log('模型发现 + 思考档位离线自检通过：代查拼接/鉴权/去重排序 · 失败原因可读 · off 不发字段 · 密钥复用仅限同地址')
} finally {
  server.close()
}
