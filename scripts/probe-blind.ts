/**
 * 临时探针：现场为空时，被兜底叫到的角色实际拿到什么输入。用完即删。
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { GroupSession } from '../src/group/engine.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'
import { assembleGroup } from '../src/group/host.ts'
import { loadFiles } from '../src/group/status.ts'

const G = '_xp-blind'
const dir = join(config.groupsDir, G)
try {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  buildGroupFixture(dir, { chars: TEST_CAST.slice(0, 2) })
  let s = GroupSession.open(G)
  // 第 1、2 轮：正常在场，甲说过两句话
  s.store.append('user', '你', '甲，你先前那句话一', ['角色甲'])
  s.store.append('character', '角色甲', '甲的回答一', ['角色甲'])
  s = GroupSession.open(G)
  // 总管把现场判空（工具说明书明确允许 present: []）
  s.setScene({ present: [], remote: [], overhear: [] }, '现场清空')
  s = GroupSession.open(G)
  // 引擎在现场为空时给 user 行写的 visible_to 就是空名单
  s.store.append('user', '你', '现场清空后我说的第三句话', [])
  s = GroupSession.open(G)
  const files = loadFiles(join(dir, '角色', '角色甲'))
  for (const who of ['角色甲', '角色乙'] as const) {
    const persona = s.characters.find(c => c.name === who)!
    const { system, messages } = assembleGroup(persona, s.settings, s.store.effectiveMessages(), {
      files: loadFiles(join(dir, "角色", who)), memoryText: '', userPersona: s.userPersona, presentNames: [], remote: [],
    })
    console.log(`\n被兜底叫到「${who}」（${who === '角色甲' ? '以前说过话' : '从没说过话'}，两者现在都不在场）拿到的消息数组：`)
    for (const m of messages) console.log(`  role=${m.role} 内容=「${m.content}」`)
    console.log(`  条数=${messages.length} · 能否看见你刚说的第三句: ${messages.some(m => m.content.includes('第三句话')) ? '能' : '不能'} · 组装出的 system=${system.length} 字符（P1 实测：不会进请求）`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
  console.log('清理:', !existsSync(dir))
}
