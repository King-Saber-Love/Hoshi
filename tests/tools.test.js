import test from "node:test";
import assert from "node:assert/strict";
import { createContext } from "../packages/runtime/src/index.js";
import { createAgent } from "../packages/core/src/index.js";
import { LLM_SERVICE } from "../packages/llm/src/index.js";
import {
  tools,
  registerTool,
  runTool,
  TOOLS_SERVICE,
  TOOL_EVENT,
} from "../packages/tools/src/index.js";

function clockTool(now = "16:21") {
  return {
    name: "clock",
    description: "查看时间",
    schema: { type: "object", properties: { zone: { type: "string" } } },
    execute(args) {
      return `${now} ${args.zone ?? "UTC"}`;
    },
  };
}

function fakeLlm(script) {
  let index = 0;
  return {
    async *stream() {
      const item = script[index];
      index += 1;
      for (const chunk of item) yield chunk;
    },
  };
}

test("没有挂管线时，registerTool 和 runTool 会提示先挂插件", () => {
  const ctx = createContext();
  assert.throws(() => registerTool(ctx, clockTool()), /请先 ctx.plugin\(tools\(\)\)/);
  assert.throws(() => runTool(ctx, { name: "clock" }), /请先 ctx.plugin\(tools\(\)\)/);
});

test("挂上插件后可以登记工具，list 只暴露给模型看的字段", () => {
  const ctx = createContext();
  ctx.plugin(tools());
  registerTool(ctx, clockTool());
  const listed = ctx.get(TOOLS_SERVICE).list();
  assert.deepEqual(listed, [
    {
      name: "clock",
      description: "查看时间",
      schema: { type: "object", properties: { zone: { type: "string" } } },
    },
  ]);
  assert.equal(typeof listed[0].execute, "undefined");
});

test("run 会调用 execute，arguments 和 args 两种写法都能用", async () => {
  const ctx = createContext();
  ctx.plugin(tools());
  registerTool(ctx, clockTool());
  assert.equal(await runTool(ctx, { name: "clock", arguments: { zone: "Asia/Shanghai" } }), "16:21 Asia/Shanghai");
  assert.equal(await runTool(ctx, { name: "clock", args: { zone: "UTC" } }), "16:21 UTC");
});

test("也可以在 tools({ tools }) 里一并登记", async () => {
  const ctx = createContext();
  ctx.plugin(tools({ tools: [clockTool()] }));
  assert.equal(await ctx.get(TOOLS_SERVICE).run({ name: "clock", arguments: {} }), "16:21 UTC");
});

test("重复登记同名工具会抛错", () => {
  const ctx = createContext();
  ctx.plugin(tools());
  registerTool(ctx, clockTool());
  assert.throws(() => registerTool(ctx, clockTool()), /已经登记过了/);
});

test("未注册的工具、缺少 name、缺少 execute 都会抛错", async () => {
  const ctx = createContext();
  ctx.plugin(tools());
  assert.throws(() => registerTool(ctx, { name: "bad" }), /需要 execute 函数/);
  assert.throws(() => registerTool(ctx, { execute() {} }), /非空的 name/);
  await assert.rejects(() => runTool(ctx, { name: "missing" }), /未注册的工具: missing/);
  await assert.rejects(() => runTool(ctx, {}), /需要 name/);
});

test("卸载登记它的插件时，工具会被撤销", async () => {
  const ctx = createContext();
  ctx.plugin(tools());
  const uninstall = ctx.plugin((inner) => {
    registerTool(inner, clockTool());
  });
  assert.equal((await ctx.get(TOOLS_SERVICE).list()).length, 1);
  uninstall();
  assert.deepEqual(ctx.get(TOOLS_SERVICE).list(), []);
  assert.equal(typeof ctx.get(TOOLS_SERVICE).run, "function");
});

test("pre-execute 可以改写参数，也可以拒绝调用", async () => {
  const ctx = createContext();
  ctx.plugin(tools());
  registerTool(ctx, clockTool());

  ctx.on(TOOL_EVENT.PRE_EXECUTE, (decision) => ({
    ...decision,
    arguments: { zone: "Europe/Paris" },
  }));
  assert.equal(await runTool(ctx, { name: "clock", arguments: { zone: "UTC" } }), "16:21 Europe/Paris");

  const locked = createContext();
  locked.plugin(tools({ tools: [clockTool()] }));
  locked.on(TOOL_EVENT.PRE_EXECUTE, () => ({ kind: "deny", reason: "未经批准" }));
  await assert.rejects(() => runTool(locked, { name: "clock", arguments: {} }), /未经批准/);
});

test("execute 事件会在真正执行时发出，post-execute 可以改写返回值", async () => {
  const ctx = createContext();
  const seen = [];
  ctx.plugin(tools());
  registerTool(ctx, {
    name: "echo",
    execute(args) {
      seen.push(`run:${args.text}`);
      return args.text;
    },
  });
  ctx.on(TOOL_EVENT.EXECUTE, (exec) => {
    seen.push(`emit:${exec.name}`);
  });
  ctx.on(TOOL_EVENT.POST_EXECUTE, (decision) => ({
    ...decision,
    result: `wrapped:${decision.result}`,
  }));

  assert.equal(await runTool(ctx, { name: "echo", arguments: { text: "hi" } }), "wrapped:hi");
  assert.deepEqual(seen, ["emit:echo", "run:hi"]);
});

test("post-execute 拒绝时，工具的返回值不会交给调用方", async () => {
  const ctx = createContext();
  ctx.plugin(tools({ tools: [clockTool()] }));
  ctx.on(TOOL_EVENT.POST_EXECUTE, () => ({ kind: "deny", reason: "结果不可用" }));
  await assert.rejects(() => runTool(ctx, { name: "clock", arguments: {} }), /结果不可用/);
});

test("可以挂到 createAgent 上，模型调工具时会走完整管线", async () => {
  const ctx = createContext();
  ctx.plugin(tools());
  registerTool(ctx, clockTool());
  ctx.provide(LLM_SERVICE, fakeLlm([
    [{ type: "text", text: "我去看一下" }, { type: "tool_call", toolCall: { id: "call-1", name: "clock", arguments: { zone: "Asia/Shanghai" } } }],
    [{ type: "text", text: "现在是 16:21" }],
  ]));

  const agent = createAgent(ctx);
  await agent.runTurn("现在几点");
  assert.deepEqual(agent.session.history(), [
    { role: "user", content: "现在几点" },
    {
      role: "assistant",
      content: "我去看一下",
      toolCalls: [{ id: "call-1", name: "clock", arguments: { zone: "Asia/Shanghai" } }],
    },
    { role: "tool", content: "16:21 Asia/Shanghai", name: "clock", toolCallId: "call-1" },
    { role: "assistant", content: "现在是 16:21" },
  ]);
});
