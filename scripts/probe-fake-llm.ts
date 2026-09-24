/**
 * 假模型端点（只为抓包，不发真实请求）。用完即删。
 * 收到 /chat/completions：
 *   - 带 tools 的请求 = 总管 → 回一个 tool_call（参数由 FAKE_DIRECTOR_ARGS 指定）
 *   - 不带的 = 角色 → 回 SSE 流（第一个 delta 之后停 delayFake 毫秒，给"断流"留出窗口）
 * 每个请求原样追加进 capturePath（一行一个 JSON），供探针检查。
 */
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync } from 'node:fs'

const port = Number(process.argv[2] ?? 8931)
const capturePath = process.argv[3]
const stopMs = Number(process.env.FAKE_STOP_MS ?? 1500)
writeFileSync(capturePath, '', 'utf8')

const DIRECTOR_ARGS = process.env.FAKE_DIRECTOR_ARGS
  ?? '{"next_speaker":"角色甲","reason":"测试点名","state_updates":[{"character":"角色甲","field":"身体状况","value":"左手被割伤"}],"knowledge_appends":[{"character":"角色甲","source":"推断","entry":"（导演记的账）他怀疑有人偷听"}]}'

createServer((req, res) => {
  let raw = ''
  req.on('data', d => { raw += d })
  req.on('end', () => {
    let body: Record<string, unknown> = {}
    try { body = JSON.parse(raw) as Record<string, unknown> } catch { /* 忽略 */ }
    const msgs = (body.messages ?? []) as Array<{ role: string; content: string }>
    const isDirector = Array.isArray(body.tools) && body.tools.length > 0
    appendFileSync(capturePath, JSON.stringify({
      at: Date.now(), kind: isDirector ? 'director' : 'character',
      hasSystem: msgs.some(m => m.role === 'system'),
      systemLen: msgs.find(m => m.role === 'system')?.content.length ?? 0,
      roles: msgs.map(m => m.role),
      firstUser: msgs.find(m => m.role === 'user')?.content.slice(0, 60) ?? '',
      fullBody: raw,
    }) + '\n', 'utf8')
    process.stderr.write(`[${isDirector ? 'director' : 'character'}] system=${String(msgs.some(m => m.role === 'system'))} 条数=${msgs.length}\n`)

    if (isDirector) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id: 'c1', object: 'chat.completion', model: String(body.model),
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: (body.tools as Array<{ function: { name: string } }>)[0].function.name, arguments: DIRECTOR_ARGS } }] }, finish_reason: 'tool_calls' }],
      }))
      return
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const chunk = (text: string, last = false): void => {
      res.write(`data: ${JSON.stringify({ id: 'c2', object: 'chat.completion.chunk', model: String(body.model), choices: [{ index: 0, delta: last ? {} : { content: text }, finish_reason: last ? 'stop' : null }] })}\n\n`)
    }
    chunk('测试台词第一段。')
    setTimeout(() => {
      chunk('第二段（若断流则不应落盘）。')
      res.write('data: [DONE]\n\n')
      res.end()
    }, stopMs)
  })
}).listen(port, '127.0.0.1', () => process.stderr.write(`fake llm on ${port}\n`))
