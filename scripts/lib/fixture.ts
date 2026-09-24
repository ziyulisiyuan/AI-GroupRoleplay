/**
 * 临时夹具：程序化生成五文件模型下的群聊目录。
 * 仓库内不保存任何示例角色——所有测试数据都在这里现造，脚本结束即删。
 * 路由只依据角色名与上下文（总管 LLM 判断），没有别名表可依赖。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FixtureChar {
  dir: string
  name: string
  /** 用户填写的初始性格 → 性格.md */
  personality: string
  /** 外观/建模 → 角色.md（用户专属） */
  appearance?: string
  relationships?: string
}

export function buildGroupFixture(
  dir: string,
  opts: { era?: string; world?: string; tone?: string; chars: FixtureChar[] },
): void {
  const w = (rel: string, content: string): void => {
    const f = join(dir, rel)
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, content, 'utf8')
  }
  w('群设定.yaml', `era: ${opts.era ?? '（测试用时代背景）'}\nworld: |\n  ${opts.world ?? '（测试用世界观）'}\ntone: ${opts.tone ?? ''}\n`)
  for (const c of opts.chars) {
    w(
      `角色/${c.dir}/角色.md`,
      `---\nname: ${c.name}\nappearance: |\n  ${c.appearance ?? '（测试用外观）'}\n---\n\n（测试用背景）\n`,
    )
    w(`角色/${c.dir}/性格.md`, `# 性格\n\n${c.personality}\n\n## 性格演变\n`)
    w(`角色/${c.dir}/人物关系.md`, `# 人物关系\n\n${c.relationships ?? '（测试用关系备注）'}\n`)
    w(`角色/${c.dir}/状态.yaml`, '{}\n')
    w(`角色/${c.dir}/记忆.jsonl`, '')
  }
}

/**
 * 标准测试班底（角色甲/乙/丙）——只给**行为性**设定（问什么答什么 / 谨慎 / 配合），
 * 不写任何虚构人设或世界观：这些是让引擎行为可测的最小脚手架。
 * 名字留"角色X"而非花名，避免夹具变成示例内容。
 */
export const TEST_CAST: FixtureChar[] = [
  { dir: '角色甲', name: '角色甲', personality: '（测试设定：有话直说，别人问什么就答什么，不装傻、不回避、不推说不知道）', appearance: '（测试外观）', relationships: '（测试关系）' },
  { dir: '角色乙', name: '角色乙', personality: '（测试设定：谨慎寡言，但被直接问到会如实回答）', appearance: '（测试外观）', relationships: '（测试关系）' },
  { dir: '角色丙', name: '角色丙', personality: '（测试设定：乐于配合别人的请求，答应了就守口如瓶）', appearance: '（测试外观）', relationships: '（测试关系）' },
]
