/**
 * 官方 DeepSeek Messages 传输层：用 POST 发送请求，
 * Accept 为 text/event-stream，再把 SSE 译成 Hoshi 的流式分片。
 * 使用原生 fetch，不包一层 SDK。
 *
 * @param {object} [config]
 * @param {string} [config.apiKey]
 * @param {string} [config.messagesApiRoot]
 * @returns {import("@hoshi/runtime").HoshiPlugin}
 */
export function llmDeepseek(config) {
  throw new Error("TODO: @hoshi/llm-deepseek llmDeepseek");
}

export default llmDeepseek;
