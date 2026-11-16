/**
 * Agent 核心：turn/step 循环，以及系统提示词和工具 schema 的组装。
 * 循环在进程内运行。模型调用走 llm 缝，工具调用走 tools 管线。
 *
 * @typedef {object} HoshiAgent
 * @property {object} session
 * @property {(input: string) => Promise<void>} runTurn
 */

/**
 * 基于插件上下文和会话日志创建一个 Agent。
 * @param {import("@hoshi/runtime").HoshiContext} ctx
 * @param {object} [options]
 * @returns {HoshiAgent}
 */
export function createAgent(ctx, options) {
  throw new Error("TODO: @hoshi/core createAgent");
}

/**
 * 跑完一轮用户 turn，包括其间的工具步骤。
 * @param {HoshiAgent} agent
 * @param {string} input
 * @returns {Promise<void>}
 */
export function runTurn(agent, input) {
  throw new Error("TODO: @hoshi/core runTurn");
}
