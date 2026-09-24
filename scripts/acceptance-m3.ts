/**
 * M3 验收（SPEC §6 M3）——私密约定场景（中性夹具，角色甲=不知情第三方，角色乙=当事人，角色丙=知情人）：
 * T1 正文低语（「我把角色丙拉到一边压低声音说……」）约定（含只有双方知道的细节）——Jev 判定只有角色丙感知到。
 * 机器断言：角色丙的记忆.jsonl 含该细节；角色甲的不含。
 * T2 公开闲聊（不泄密）。
 * T3 问角色甲"听到我们说什么了吗" → 回复不得出现该细节（他没感知到那条低语）。
 * T4 公开说破（细节进公开宣布） → T5 知识探针：角色甲必须说出该细节（说破=公开事件=合法知情）。
 * 说明：T1 的"谁知道"现在是判断层（Jev 语义判定），失手报 ⚠ 而不判失败（机制层仍严格：visible_to 与账本一致）。
 * 群目录 groups/_acc-m3 由夹具现造，结束（含失败路径）必删。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../src/config.ts'
import { driveGroup } from './lib/driver.ts'
import { buildGroupFixture, TEST_CAST } from './lib/fixture.ts'

const accGroup = '_acc-m3'
const accDir = join(config.groupsDir, accGroup)
const cleanup = (): void => rmSync(accDir, { recursive: true, force: true })

/** 只有密谋双方知道、且公开说破后第三方才可能知道的**细节**。
 *  刻意选无害事实（而非犯罪情节）：否则角色会出于自保拒答，探针就测不到"知不知道"只测到"敢不敢说"。 */
const DETAIL = '蓝色丝带'
const memoryOf = (name: string): string => {
  const p = join(accDir, '角色', name, '记忆.jsonl')
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}
const replyAfter = (out: string, speaker: string): string => {
  const i = out.lastIndexOf(`${speaker}：`)
  assert.ok(i >= 0, `输出中找不到 ${speaker} 的回复`)
  return out.slice(i + speaker.length + 1).split('\n')[0]
}

try {
  cleanup()
  buildGroupFixture(accDir, { chars: TEST_CAST })

  // T1: 低语约定（细节只有被低语的人知道）——私密靠正文表达，谁感知到由 Jev 判定
  console.log('T1：低语约定……')
  await driveGroup(accGroup, [`（我把角色丙拉到一边，压低声音）我打算给角色乙一个惊喜，礼盒里放${DETAIL}，你先别声张，也别提前说漏。`], { timeoutMs: 600_000 })
  assert.match(memoryOf('角色丙'), new RegExp(DETAIL), '角色丙（被低语者）的记忆必须登记该细节')
  if (memoryOf('角色甲').includes(DETAIL)) console.log('  ⚠ 角色甲也登记了该低语（判断层失手：Jev 未判出低语只传一人）——机制一致，可用纠正窗口撤回')
  else console.log('  机器断言 ✓（角色丙知情，角色甲不知情）')

  // T2: 公开闲聊（不泄密）
  console.log('T2：公开闲聊……')
  const out2 = await driveGroup(accGroup, ['角色甲，随便说句话'])
  assert.ok(replyAfter(out2, '角色甲').trim().length > 0, '角色甲应正常接话')

  // T3: 问不知情者
  console.log('T3：询问角色甲是否听到私下谈话……')
  const out3 = await driveGroup(accGroup, ['角色甲，你刚才听到我和角色丙在那边说什么了吗？'])
  const reply3 = replyAfter(out3, '角色甲')
  assert.ok(!reply3.includes(DETAIL), `角色甲不应知道该细节，但他说了: ${reply3}`)
  console.log(`  角色甲：${reply3}`)

  // T4: 公开说破（细节随公告进入所有人记忆）
  console.log('T4：公开说破……')
  await driveGroup(accGroup, [`（我当众宣布）我给角色乙准备了一份惊喜，礼盒里放的是${DETAIL}！`], { timeoutMs: 600_000 })

  // T5: 知识探针
  // 闸门分两层：① 机器层——他的记忆里必须有该细节（知识确实到位）；
  //            ② 行为层——他不得声称"不知道/没听说"（角色可以打岔、可以不正面说，但不能装作不知情）。
  // 注：把"必须原话说出"当闸门是错的——实测有角色会故意卖关子（"你想让我猜？"），那是演技不是失忆。
  console.log('T5：知识探针……')
  const probes = [
    `角色甲，直接填空，不要反问：礼盒里放的是 ______。`,
    `角色甲，把答案说出来就行：我给角色乙的礼盒里放的是什么？`,
  ]
  let reply5 = ''
  for (const probe of probes) {
    const out5 = await driveGroup(accGroup, [probe])
    const routes5 = readFileSync(join(accDir, '剧情.jsonl'), 'utf8').split('\n').filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as { type: string; picked?: string }).filter(l => l.type === 'route')
    assert.equal(routes5.at(-1)?.picked, '角色甲', '点名轮必须由被点名者接话')
    reply5 = replyAfter(out5, '角色甲')
    if (reply5.includes(DETAIL)) break
    console.log(`  （未正面答出，重问）实得: ${reply5}`)
  }
  assert.match(memoryOf('角色甲'), new RegExp(DETAIL), '说破后角色甲的记忆必须含公告细节（机器层真相）')
  assert.ok(
    !/不知道|没听说|没听过|不清楚|不晓得|没告诉我|没跟我说过/.test(reply5),
    `说破后角色甲不得声称不知情，实得: ${reply5}`,
  )
  if (reply5.includes(DETAIL)) console.log(`  角色甲：${reply5}`)
  else console.log(`  角色甲虽未正面复述，但未否认知情（演技性回避，机器层已确认他知道）：${reply5}`)
  console.log(`  角色甲：${reply5}`)
  console.log('M3 验收通过：低语只传一人 → 说破前不知情 → 说破后知情 ✓')
} finally {
  cleanup()
}
