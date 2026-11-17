import test from "node:test";
import assert from "node:assert/strict";
import { createContext } from "../packages/runtime/src/index.js";
import { LLM_SERVICE } from "../packages/llm/src/index.js";
import { createAgent } from "../packages/core/src/index.js";
import {
  llmDeepseek,
  toAnthropicMessages,
  toAnthropicTools,
  resolveMessagesUrl,
  DEFAULT_MESSAGES_API_ROOT,
} from "../packages/llm-deepseek/src/index.js";

function sse(events) {
  return `${events
    .map((item) => {
      const lines = [];
      if (item.event) lines.push(`event: ${item.event}`);
      lines.push(`data: ${typeof item.data === "string" ? item.data : JSON.stringify(item.data)}`);
      return lines.join("\n");
    })
    .join("\n\n")}\n\n`;
}

function textStream(text) {
  return sse([
    { event: "message_start", data: { type: "message_start", message: { id: "m1", role: "assistant", content: [] } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}

function toolStream() {
  return sse([
    { event: "message_start", data: { type: "message_start", message: { id: "m2", role: "assistant", content: [] } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "我去看一下" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    {
      event: "content_block_start",
      data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call-1", name: "clock", input: {} } },
    },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"zone\":" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"Asia/Shanghai\"}" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}

function fakeFetch(handler) {
  return async (url, init) => handler(url, init);
}

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

test("resolveMessagesUrl 会按 Anthropic base_url 补上 /v1/messages", () => {
  assert.equal(resolveMessagesUrl(), `${DEFAULT_MESSAGES_API_ROOT}/v1/messages`);
  assert.equal(resolveMessagesUrl("https://api.deepseek.com/anthropic/messages"), "https://api.deepseek.com/anthropic/messages");
});

test("系统提示会抽到顶层 system，连续 tool 结果会合并成一条 user", () => {
  const mapped = toAnthropicMessages([
    { role: "system", content: "你是助手" },
    { role: "user", content: "现在几点" },
    {
      role: "assistant",
      content: "我去看一下",
      toolCalls: [{ id: "call-1", name: "clock", arguments: { zone: "Asia/Shanghai" } }],
    },
    { role: "tool", content: "16:21", name: "clock", toolCallId: "call-1" },
  ]);
  assert.equal(mapped.system, "你是助手");
  assert.deepEqual(mapped.messages[1].content, [
    { type: "text", text: "我去看一下" },
    { type: "tool_use", id: "call-1", name: "clock", input: { zone: "Asia/Shanghai" } },
  ]);
  assert.equal(mapped.messages[2].role, "user");
  assert.deepEqual(mapped.messages[2].content, [
    { type: "tool_result", tool_use_id: "call-1", content: "16:21" },
  ]);
});

test("客户端工具会转成 input_schema，且不带 type 字段", () => {
  const tools = toAnthropicTools([{ name: "clock", description: "查看时间", schema: { type: "object", properties: { zone: { type: "string" } } } }]);
  assert.equal(tools[0].name, "clock");
  assert.deepEqual(tools[0].input_schema, { type: "object", properties: { zone: { type: "string" } } });
  assert.equal("type" in tools[0], false);
});

test("插件会把 llm.stream 挂到上下文上，并把 SSE 文本译成 Hoshi 分片", async () => {
  /** @type {string | undefined} */
  let sentUrl;
  /** @type {object | undefined} */
  let sentBody;
  const ctx = createContext();
  ctx.plugin(llmDeepseek({
    apiKey: "test-key",
    fetch: fakeFetch(async (url, init) => {
      sentUrl = url;
      sentBody = JSON.parse(init.body);
      assert.equal(init.headers.Authorization, "Bearer test-key");
      assert.equal(init.headers.accept, "text/event-stream");
      return new Response(textStream("你好"), { status: 200, headers: { "content-type": "text/event-stream" } });
    }),
  }));

  const llm = await ctx.inject(LLM_SERVICE);
  const chunks = await collect(llm.stream({
    messages: [
      { role: "system", content: "你是助手" },
      { role: "user", content: "嗨" },
    ],
  }));

  assert.equal(sentUrl, `${DEFAULT_MESSAGES_API_ROOT}/v1/messages`);
  assert.equal(sentBody.model, "deepseek-flash");
  assert.equal(sentBody.stream, true);
  assert.equal(sentBody.system, "你是助手");
  assert.deepEqual(sentBody.messages, [{ role: "user", content: "嗨" }]);
  assert.deepEqual(chunks, [{ type: "text", text: "你好" }]);
});

test("工具参数的 JSON 片段会先拼接，在 content_block_stop 后再产出 tool_call", async () => {
  const ctx = createContext();
  ctx.plugin(llmDeepseek({
    apiKey: "test-key",
    fetch: fakeFetch(async () => new Response(toolStream(), { status: 200 })),
  }));
  const llm = await ctx.inject(LLM_SERVICE);
  const chunks = await collect(llm.stream({
    messages: [{ role: "user", content: "现在几点" }],
    tools: [{ name: "clock", schema: { type: "object", properties: {} } }],
  }));
  assert.deepEqual(chunks, [
    { type: "text", text: "我去看一下" },
    { type: "tool_call", toolCall: { id: "call-1", name: "clock", arguments: { zone: "Asia/Shanghai" } } },
  ]);
});

test("HTTP 错误会带上接口返回的信息", async () => {
  const ctx = createContext();
  ctx.plugin(llmDeepseek({
    apiKey: "bad",
    fetch: fakeFetch(async () => new Response(JSON.stringify({
      type: "error",
      error: { type: "authentication_error", message: "invalid api key" },
    }), { status: 401 })),
  }));
  const llm = await ctx.inject(LLM_SERVICE);
  await assert.rejects(
    () => collect(llm.stream({ messages: [{ role: "user", content: "嗨" }] })),
    /invalid api key/,
  );
});

test("缺少 API Key 时会立刻抛错，不会发请求", async () => {
  const previous = process.env.HOSHI_DEEPSEEK_API_KEY;
  delete process.env.HOSHI_DEEPSEEK_API_KEY;
  const ctx = createContext();
  let called = false;
  ctx.plugin(llmDeepseek({
    fetch: fakeFetch(async () => {
      called = true;
      return new Response("nope", { status: 500 });
    }),
  }));
  const llm = await ctx.inject(LLM_SERVICE);
  await assert.rejects(
    () => collect(llm.stream({ messages: [{ role: "user", content: "嗨" }] })),
    /HOSHI_DEEPSEEK_API_KEY/,
  );
  assert.equal(called, false);
  if (previous !== undefined) process.env.HOSHI_DEEPSEEK_API_KEY = previous;
});

test("流在 message_stop 之前结束时视为不完整", async () => {
  const ctx = createContext();
  ctx.plugin(llmDeepseek({
    apiKey: "test-key",
    fetch: fakeFetch(async () => new Response(sse([
      { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "半" } } },
    ]), { status: 200 })),
  }));
  const llm = await ctx.inject(LLM_SERVICE);
  await assert.rejects(
    () => collect(llm.stream({ messages: [{ role: "user", content: "嗨" }] })),
    /message_stop/,
  );
});

test("适配器可以挂到 createAgent 上跑完一轮纯文本", async () => {
  const ctx = createContext();
  ctx.plugin(llmDeepseek({
    apiKey: "test-key",
    model: "deepseek-v4-pro",
    fetch: fakeFetch(async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, "deepseek-v4-pro");
      return new Response(textStream("等于 2"), { status: 200 });
    }),
  }));
  const agent = createAgent(ctx);
  await agent.runTurn("1+1 等于几");
  assert.deepEqual(
    agent.session.history().map((message) => ({ role: message.role, content: message.content })),
    [
      { role: "user", content: "1+1 等于几" },
      { role: "assistant", content: "等于 2" },
    ],
  );
});
