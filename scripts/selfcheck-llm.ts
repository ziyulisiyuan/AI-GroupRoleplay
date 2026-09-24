/**
 * LLM 通道自检（无需角色、无示例内容）：验证 API key、模型名、思考参数与流式解析可用。
 * 不写任何剧情文件，纯临时调用。无 key 时跳过（退出 0）。
 */
import assert from 'node:assert/strict'
import { config } from '../src/config.ts'
import { turnFromMessages } from '../src/host.ts'

if (config.apiKey === '') {
  console.log('未设置 DEEPSEEK_API_KEY，跳过在线自检')
  process.exit(0)
}

let received = ''
for await (const delta of turnFromMessages([
  { role: 'system', content: '你是一个测试端点。' },
  { role: 'user', content: '只回复两个字：收到' },
])) {
  received += delta
}
assert.ok(received.trim().length > 0, '必须收到非空流')
console.log(`LLM 通道自检通过：model=${config.model} effort=${config.reasoningEffort} 收到 ${received.length} 字符`)
