/**
 * DeepSeek Messages 适配器。
 *
 * 以插件形式挂到上下文上，provide("llm", { stream })。
 * 传输层用原生 fetch 调用 Anthropic 兼容的 Messages 接口，
 * Accept 为 text/event-stream，再把 SSE 译成 Hoshi 的 { type: "text" | "tool_call" } 分片。
 * 不包一层 SDK。
 */

import { LLM_SERVICE } from "@hoshi/llm";

/** Anthropic SDK 使用的 base_url；后面会再拼上 /v1/messages。 */
export const DEFAULT_MESSAGES_API_ROOT = "https://api.deepseek.com/anthropic";

/** 当前文档推荐的默认模型，可在配置里换。 */
export const DEFAULT_MODEL = "deepseek-flash";

const DEFAULT_MAX_TOKENS = 8192;

/**
 * @param {object} [config]
 * @param {string} [config.apiKey] 默认读环境变量 HOSHI_DEEPSEEK_API_KEY
 * @param {string} [config.messagesApiRoot] 默认 https://api.deepseek.com/anthropic
 * @param {string} [config.model] 默认 deepseek-flash
 * @param {number} [config.maxTokens]
 * @param {typeof fetch} [config.fetch] 测试时可注入假的 fetch
 * @returns {import("@hoshi/runtime").HoshiPlugin}
 */
export function llmDeepseek(config = {}) {
  return (ctx) => {
    ctx.provide(LLM_SERVICE, {
      /**
       * @param {import("@hoshi/llm").LlmRequest} request
       * @returns {AsyncIterable<import("@hoshi/llm").LlmStreamChunk>}
       */
      stream(request) {
        return streamDeepseek(request, config);
      },
    });
  };
}

export default llmDeepseek;

/**
 * 实际发请求、读 SSE、向外产出分片。
 * @param {import("@hoshi/llm").LlmRequest} request
 * @param {object} config
 * @returns {AsyncIterable<import("@hoshi/llm").LlmStreamChunk>}
 */
async function* streamDeepseek(request, config) {
  const apiKey = config.apiKey ?? process.env.HOSHI_DEEPSEEK_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new Error("缺少 DeepSeek API Key，请传入 config.apiKey 或设置 HOSHI_DEEPSEEK_API_KEY");
  }

  const options = request?.options ?? {};
  const body = buildRequestBody(request, config, options);
  const url = resolveMessagesUrl(config.messagesApiRoot);
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("当前环境没有 fetch，无法调用 DeepSeek Messages 接口");
  }

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await readHttpError(response));
  }
  if (!response.body) {
    throw new Error("DeepSeek 响应没有可读的正文");
  }

  let stopped = false;
  /** @type {Map<number, { type: string, id?: string, name?: string, json: string }>} */
  const blocks = new Map();

  for await (const sseEvent of parseSse(response.body)) {
    const payload = parseJson(sseEvent.data);
    const type = sseEvent.event || payload?.type;

    if (payload && payload.error && type !== "content_block_delta") {
      throw new Error(formatApiError(payload));
    }

    if (type === "content_block_start") {
      const block = payload.content_block ?? {};
      blocks.set(payload.index, {
        type: block.type,
        id: block.id,
        name: block.name,
        json: "",
      });
      continue;
    }

    if (type === "content_block_delta") {
      const delta = payload.delta ?? {};
      if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
        yield { type: "text", text: delta.text };
      } else if (delta.type === "input_json_delta") {
        const current = blocks.get(payload.index);
        if (current && typeof delta.partial_json === "string") {
          current.json += delta.partial_json;
        }
      }
      continue;
    }

    if (type === "content_block_stop") {
      const current = blocks.get(payload.index);
      if (current?.type === "tool_use") {
        yield {
          type: "tool_call",
          toolCall: {
            id: current.id,
            name: current.name,
            arguments: parseToolArguments(current.json),
          },
        };
      }
      continue;
    }

    if (type === "message_stop") {
      stopped = true;
      break;
    }
  }

  if (!stopped) {
    throw new Error("DeepSeek 流在 message_stop 之前结束，响应不完整");
  }
}

/**
 * 把 Hoshi 的 messages / tools 转成 Messages API 请求体。
 * 系统提示从 messages 里抽到顶层 system；连续的 tool 消息会合并成一条 user。
 * @param {import("@hoshi/llm").LlmRequest} request
 * @param {object} config
 * @param {object} options
 */
function buildRequestBody(request, config, options) {
  const { system, messages } = toAnthropicMessages(request?.messages ?? []);
  if (messages.length === 0) {
    throw new Error("发给 DeepSeek 的 messages 不能为空");
  }

  const body = {
    model: options.model ?? config.model ?? DEFAULT_MODEL,
    max_tokens: options.maxTokens ?? config.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
    messages,
  };
  if (system) body.system = system;

  const tools = toAnthropicTools(request?.tools);
  if (tools) body.tools = tools;
  if (typeof options.temperature === "number") body.temperature = options.temperature;
  return body;
}

/**
 * @param {object[]} [messages]
 * @returns {{ system?: string, messages: object[] }}
 */
export function toAnthropicMessages(messages = []) {
  const systemParts = [];
  const out = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "system") {
      if (typeof message.content === "string" && message.content.length > 0) {
        systemParts.push(message.content);
      }
      continue;
    }

    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content ?? "",
      };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.every((item) => item.type === "tool_result")) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (message.role === "assistant") {
      const content = [];
      if (typeof message.content === "string" && message.content.length > 0) {
        content.push({ type: "text", text: message.content });
      }
      if (Array.isArray(message.toolCalls)) {
        for (const call of message.toolCalls) {
          content.push({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.arguments ?? {},
          });
        }
      }
      out.push({ role: "assistant", content: content.length > 0 ? content : "" });
      continue;
    }

    out.push({ role: "user", content: message.content ?? "" });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

/**
 * 客户端工具不要带 type 字段，否则接口会当成服务端工具并可能返回 422。
 * @param {object[]} [tools]
 * @returns {object[] | undefined}
 */
export function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema ?? tool.schema ?? { type: "object", properties: {} },
  }));
}

/**
 * 若传入的已经是完整 Messages 路径就原样用，否则按 Anthropic base_url 规则补上 /v1/messages。
 * @param {string} [root]
 * @returns {string}
 */
export function resolveMessagesUrl(root) {
  const base = (root ?? DEFAULT_MESSAGES_API_ROOT).replace(/\/+$/, "");
  if (base.endsWith("/messages")) return base;
  return `${base}/v1/messages`;
}

/**
 * 把响应正文按 SSE 事件切分。事件之间是空行，可能是 \\n\\n 或 \\r\\n\\r\\n。
 * 以冒号开头的行是保活注释，忽略。
 * @param {ReadableStream<Uint8Array>} body
 */
async function* parseSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        const event = decodeSseBlock(buffer);
        if (event) yield event;
      }
      return;
    }
    buffer += decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    let separator;
    while ((separator = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const event = decodeSseBlock(raw);
      if (event) yield event;
    }
  }
}

/**
 * @param {string} raw
 * @returns {{ event?: string, data: string } | null}
 */
function decodeSseBlock(raw) {
  const lines = raw.split("\n");
  /** @type {string | undefined} */
  let event;
  const dataLines = [];
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }
  if (!event && dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/**
 * @param {string} text
 * @returns {object | null}
 */
function parseJson(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 工具参数必须等该内容块全部结束后再 JSON.parse。
 * @param {string} json
 * @returns {unknown}
 */
function parseToolArguments(json) {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("DeepSeek 工具参数不是合法 JSON，内容块可能被截断");
  }
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readHttpError(response) {
  const text = await response.text();
  const payload = parseJson(text);
  if (payload) return `DeepSeek HTTP ${response.status}: ${formatApiError(payload)}`;
  return `DeepSeek HTTP ${response.status}${text ? `: ${text}` : ""}`;
}

/**
 * @param {object} payload
 * @returns {string}
 */
function formatApiError(payload) {
  const error = payload.error ?? payload;
  if (typeof error === "string") return error;
  if (error && typeof error.message === "string") return error.message;
  return JSON.stringify(payload);
}
