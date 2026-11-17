import test from "node:test";
import assert from "node:assert/strict";
import { createContext } from "../packages/runtime/src/index.js";
import { SESSION_EVENT } from "../packages/session/src/index.js";
import { LLM_SERVICE } from "../packages/llm/src/index.js";
import { createAgent, runTurn, TOOLS_SERVICE } from "../packages/core/src/index.js";

/**
 * 做一个只会按预定脚本吐 chunk 的假模型。
 * script 是数组：每一次 stream 调用消耗下一项。
 * 某一项可以是 chunk 数组，也可以是抛错。
 * @param {Array<object[] | Error>} script
 */
function fakeLlm(script) {
  let index = 0;
  return {
    async *stream() {
      if (index >= script.length) {
        throw new Error("假模型的脚本已经用完");
      }
      const item = script[index];
      index += 1;
      if (item instanceof Error) throw item;
      for (const chunk of item) yield chunk;
    },
  };
}

function text(value) {
  return { type: "text", text: value };
}

function toolCall(id, name, args) {
  return { type: "tool_call", toolCall: { id, name, arguments: args } };
}

test("createAgent 会带上会话，runTurn 与导出函数是同一条路径", async () => {
  const ctx = createContext();
  const llm = fakeLlm([[text("好的")]]);
  ctx.provide(LLM_SERVICE, llm);
  const agent = createAgent(ctx);
  assert.equal(typeof agent.session.append, "function");
  await agent.runTurn("你好");
  assert.deepEqual(
    agent.session.history().map((message) => ({ role: message.role, content: message.content })),
    [
      { role: "user", content: "你好" },
      { role: "assistant", content: "好的" },
    ],
  );
});

test("一轮纯文本会写入 turn/start、用户消息、助手消息和 turn/end", async () => {
  const ctx = createContext();
  const agent = createAgent(ctx, { llm: fakeLlm([[text("2")]]) });
  await runTurn(agent, "1+1 等于几");

  const types = agent.session.events().map((event) => event.type);
  assert.deepEqual(types, [
    SESSION_EVENT.TURN_START,
    SESSION_EVENT.MESSAGE,
    SESSION_EVENT.STEP_START,
    SESSION_EVENT.MESSAGE,
    SESSION_EVENT.STEP_END,
    SESSION_EVENT.TURN_END,
  ]);
  const ended = agent.session.events().at(-1);
  assert.equal(ended.payload.status, "completed");
});

test("模型要求调工具时，会执行工具并把结果再交给下一轮模型", async () => {
  const ctx = createContext();
  const tools = {
    list() {
      return [{ name: "clock", description: "查看时间" }];
    },
    async run(call) {
      assert.equal(call.name, "clock");
      assert.deepEqual(call.arguments, { zone: "Asia/Shanghai" });
      return "16:21";
    },
  };
  const llm = fakeLlm([
    [text("我去看一下"), toolCall("call-1", "clock", { zone: "Asia/Shanghai" })],
    [text("现在是 16:21")],
  ]);
  const agent = createAgent(ctx, { llm, tools });
  await agent.runTurn("现在几点");

  assert.deepEqual(agent.session.history(), [
    { role: "user", content: "现在几点" },
    {
      role: "assistant",
      content: "我去看一下",
      toolCalls: [{ id: "call-1", name: "clock", arguments: { zone: "Asia/Shanghai" } }],
    },
    { role: "tool", content: "16:21", name: "clock", toolCallId: "call-1" },
    { role: "assistant", content: "现在是 16:21" },
  ]);
});

test("工具服务也可以通过 provide 注入", async () => {
  const ctx = createContext();
  ctx.provide(LLM_SERVICE, fakeLlm([
    [toolCall("call-2", "echo", { text: "hi" })],
    [text("hi")],
  ]));
  ctx.provide(TOOLS_SERVICE, {
    async run(call) {
      return call.arguments.text;
    },
  });
  const agent = createAgent(ctx);
  await agent.runTurn("跟我重复");
  const toolMessage = agent.session.history().find((message) => message.role === "tool");
  assert.equal(toolMessage.content, "hi");
});

test("没有工具服务时，工具调用会记一条错误结果，而不会把整轮打崩", async () => {
  const ctx = createContext();
  const agent = createAgent(ctx, {
    llm: fakeLlm([
      [toolCall("call-3", "shell", { cmd: "ls" })],
      [text("我没法执行")],
    ]),
  });
  await agent.runTurn("列目录");
  const toolMessage = agent.session.history().find((message) => message.role === "tool");
  assert.match(toolMessage.content, /未挂载工具服务/);
  assert.equal(agent.session.events().at(-1).payload.status, "completed");
});

test("assemble-prompt 会把系统提示加工后发给模型", async () => {
  const ctx = createContext();
  ctx.on("assemble-prompt", (prompt) => `${prompt}[规则]`);
  /** @type {object[] | undefined} */
  let seen;
  const llm = {
    async *stream(request) {
      seen = request.messages;
      yield text("收到");
    },
  };
  const agent = createAgent(ctx, { llm, system: "你是助手" });
  await agent.runTurn("嗨");
  assert.equal(seen[0].role, "system");
  assert.equal(seen[0].content, "你是助手[规则]");
  assert.equal(seen[1].role, "user");
  assert.equal(seen[1].content, "嗨");
});

test("达到 maxSteps 仍要调工具时，会以 aborted 结束本轮", async () => {
  const ctx = createContext();
  const llm = fakeLlm([
    [toolCall("call-4", "ping", {})],
  ]);
  const tools = {
    async run() {
      return "pong";
    },
  };
  const agent = createAgent(ctx, { llm, tools, maxSteps: 1 });
  await agent.runTurn("一直 ping");
  assert.equal(agent.session.events().at(-1).payload.status, "aborted");
  const roles = agent.session.history().map((message) => message.role);
  assert.deepEqual(roles, ["user", "assistant"]);
});

test("模型抛错时会记下 error 状态，并把错误重新抛出", async () => {
  const ctx = createContext();
  const agent = createAgent(ctx, { llm: fakeLlm([new Error("模型超时")]) });
  await assert.rejects(() => agent.runTurn("你好"), /模型超时/);
  const ended = agent.session.events().at(-1);
  assert.equal(ended.type, SESSION_EVENT.TURN_END);
  assert.equal(ended.payload.status, "error");
  assert.equal(ended.payload.error, "模型超时");
});

test("同一 Agent 连续两轮会写进同一份日志", async () => {
  const ctx = createContext();
  const agent = createAgent(ctx, {
    llm: fakeLlm([[text("一")], [text("二")]]),
  });
  await agent.runTurn("第一轮");
  await agent.runTurn("第二轮");
  assert.deepEqual(
    agent.session.history().map((message) => message.content),
    ["第一轮", "一", "第二轮", "二"],
  );
});

test("输入不是字符串时会抛错", async () => {
  const ctx = createContext();
  const agent = createAgent(ctx, { llm: fakeLlm([]) });
  await assert.rejects(() => agent.runTurn(null), /字符串/);
});
