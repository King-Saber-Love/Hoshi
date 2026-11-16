/**
 * OpenAI 兼容的 Chat Completions 适配器，用于接入其他模型提供方。
 *
 * @param {object} [config]
 * @param {string} [config.apiKey]
 * @param {string} [config.baseUrl]
 * @returns {import("@hoshi/runtime").HoshiPlugin}
 */
export function llmOpenai(config) {
  throw new Error("TODO: @hoshi/llm-openai llmOpenai");
}

export default llmOpenai;
