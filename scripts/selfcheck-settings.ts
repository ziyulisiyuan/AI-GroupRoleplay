/**
 * 全局规则 + 模型设置的离线自检（无需 API key，全临时目录）：
 * 1) 规则：写入/读回/空白不注入、frontmatter 剥离。
 * 2) 设置：提供方列表往返、启用项解析、缺字段忽略、无提供方回退 .env。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRules, saveRules, RULES_FILENAME } from '../src/group/rules.ts'
import { loadSettings, resolveLlm, resolveRouter, saveSettings, SETTINGS_FILENAME, type Provider } from '../src/settings.ts'
import { config } from '../src/config.ts'

const root = mkdtempSync(join(tmpdir(), 'settings-selfcheck-'))
try {
  // 1) 全局规则
  assert.equal(loadRules(root), '', '规则文件不存在时必须返回空（零内置规则）')
  saveRules('（测试规则一）\n（测试规则二）', root)
  assert.ok(readFileSync(join(root, RULES_FILENAME), 'utf8').includes('（测试规则一）'))
  assert.equal(loadRules(root), '（测试规则一）\n（测试规则二）')
  saveRules('---\nnote: x\n---\n\n（带 frontmatter 的规则）', root)
  assert.equal(loadRules(root), '（带 frontmatter 的规则）', 'frontmatter 必须剥离')
  saveRules('   ', root)
  assert.equal(loadRules(root), '', '空白规则视为无规则')

  // 2) 模型设置
  assert.deepEqual(loadSettings(root), { providers: [], activeId: '', routerId: '' }, '未配置时为空')
  assert.equal(resolveLlm(root).source, 'env', '无提供方时回退 .env')
  assert.equal(resolveLlm(root).model, config.model)
  assert.equal(resolveRouter(root), undefined, '未配置路由专用时快路径关闭')

  const p1: Provider = { id: 'p1', name: '（测试提供方一）', baseUrl: 'https://api.example.com', apiKey: 'sk-test-1', model: '（测试模型一）', reasoningEffort: 'high' }
  const p2: Provider = { id: 'p2', name: '（测试提供方二）', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test-2', model: '（测试模型二）', reasoningEffort: 'low' }
  saveSettings({ providers: [p1, p2], activeId: 'p2', routerId: 'p1' }, root)
  assert.ok(readFileSync(join(root, SETTINGS_FILENAME), 'utf8').includes('（测试提供方一）'))
  const loaded = loadSettings(root)
  assert.equal(loaded.providers.length, 2)
  assert.equal(loaded.activeId, 'p2')
  assert.equal(resolveRouter(root)?.model, '（测试模型一）', '路由专用提供方必须可解析')
  const active = resolveLlm(root)
  assert.equal(active.source, 'settings')
  assert.equal(active.model, '（测试模型二）', '启用项必须生效')
  assert.equal(active.reasoningEffort, 'low')

  // activeId 指向不存在 → 退回第一个
  saveSettings({ providers: [p1, p2], activeId: '不存在', routerId: '' }, root)
  assert.equal(resolveLlm(root).model, '（测试模型一）', 'activeId 失效时用第一个提供方')

  // 缺关键字段的条目被忽略
  saveSettings({ providers: [{ ...p1, apiKey: '' }], activeId: 'p1', routerId: 'p1' }, root)
  assert.deepEqual(loadSettings(root).providers, [], '缺 apiKey 的条目应被忽略')
  assert.equal(resolveLlm(root).source, 'env', '被忽略后回退 .env')
  assert.equal(resolveRouter(root), undefined, '路由专用项被忽略后快路径关闭（防悬空）')

  console.log('规则/模型设置自检通过：规则零内置与往返 · 提供方解析与回退')
} finally {
  rmSync(root, { recursive: true, force: true })
}
