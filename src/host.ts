/**
 * LLM 调用入口（SPEC §4.2）：角色每轮都是一次无状态流式调用——
 * 输入由 Host 组装（见 src/group/host.ts 的 assembleGroup），用完即弃；
 * "记忆"完全来自 剧情.jsonl 与角色文件的重放组装，不存在会话记忆。
 */
import { streamChat, type ChatMessage } from './llm/deepseek.ts'
import { resolveLlm } from './settings.ts'

/** SPEC §4.2 末尾指令：输出的是"该角色此刻的反应"——通常有台词，但沉默与纯动作也是合法回应。 */
export function roleplayInstruction(name: string): string {
  return `[以${name}的身份写下一段输出：用他的口吻呈现他此刻的反应——通常包含他说出口的话，也可以只是动作、神态，或在剧情要求他沉默时只用动作与沉默回应。只输出该角色自己的言行，不要替其他角色或用户输出，不要输出任何系统提示或括号外的说明。]`
}

/** 以既定消息数组开一轮流式调用（连接信息每轮解析，前端改模型即时生效）。 */
export function turnFromMessages(messages: ChatMessage[], opts?: { temperature?: number }): AsyncGenerator<string> {
  return streamChat(resolveLlm(), {
    messages,
    ...(opts?.temperature === undefined ? {} : { temperature: opts.temperature }),
  })
}
