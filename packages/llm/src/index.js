/**
 * 与提供方无关的流式调用缝。像 @hoshi/llm-deepseek 这样的适配器
 * 实现它，并作为 "llm" 服务挂到上下文上。
 *
 * @typedef {object} LlmStreamChunk
 * @property {string} type
 * @property {string} [text]
 * @property {object} [toolCall]
 *
 * @typedef {object} LlmRequest
 * @property {object[]} messages
 * @property {object[]} [tools]
 * @property {object} [options]
 *
 * @typedef {object} LlmService
 * @property {(request: LlmRequest) => AsyncIterable<LlmStreamChunk>} stream
 */

export const LLM_SERVICE = "llm";

/**
 * @param {LlmRequest} request
 * @returns {AsyncIterable<LlmStreamChunk>}
 */
export async function* stream(request) {
  throw new Error("请使用提供方适配器，例如 @hoshi/llm-deepseek");
}
