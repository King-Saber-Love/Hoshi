import test from "node:test";
import assert from "node:assert/strict";
import { createContext } from "../packages/runtime/src/index.js";
import { tools, registerTool, runTool, TOOL_EVENT, APPROVALS_SERVICE } from "../packages/tools/src/index.js";

function clockTool(now = "16:21") {
  return {
    name: "clock",
    execute(args) {
      return `${now} ${args.zone ?? "UTC"}`;
    },
  };
}

test("pre-execute 返回 ask、又没有审批服务时，会拒绝执行", async () => {
  const ctx = createContext();
  let ran = false;
  ctx.plugin(tools());
  registerTool(ctx, {
    name: "clock",
    execute() {
      ran = true;
      return "no";
    },
  });
  ctx.on(TOOL_EVENT.PRE_EXECUTE, (decision) => ({ ...decision, kind: "ask", reason: "需要确认" }));

  await assert.rejects(() => runTool(ctx, { name: "clock", arguments: {} }), /没有挂载审批服务/);
  assert.equal(ran, false);
  assert.equal(ctx.get(APPROVALS_SERVICE), undefined);
});

test("审批服务返回 allowed-once 后会执行，并沿用 ask 阶段改写过的参数", async () => {
  const ctx = createContext();
  const asked = [];
  ctx.plugin(tools());
  ctx.provide(APPROVALS_SERVICE, {
    async request(request) {
      asked.push(request);
      return "allowed-once";
    },
  });
  registerTool(ctx, clockTool());
  ctx.on(TOOL_EVENT.PRE_EXECUTE, (decision) => ({
    ...decision,
    kind: "ask",
    arguments: { zone: "Europe/Paris" },
    reason: "改时区并询问",
  }));

  assert.equal(await runTool(ctx, { name: "clock", id: "call-1", arguments: { zone: "UTC" } }), "16:21 Europe/Paris");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].toolName, "clock");
  assert.equal(asked[0].callId, "call-1");
  assert.deepEqual(asked[0].arguments, { zone: "Europe/Paris" });
  assert.equal(asked[0].reason, "改时区并询问");
});

test("审批服务返回 rejected / unavailable / cancelled 时都不会执行工具", async () => {
  async function runWithOutcome(outcome) {
    const ctx = createContext();
    let ran = false;
    ctx.plugin(tools());
    ctx.provide(APPROVALS_SERVICE, {
      async request() {
        return outcome;
      },
    });
    registerTool(ctx, {
      name: "clock",
      execute() {
        ran = true;
        return "no";
      },
    });
    ctx.on(TOOL_EVENT.PRE_EXECUTE, (decision) => ({ ...decision, kind: "ask" }));
    return { ctx, ran, run: () => runTool(ctx, { name: "clock", arguments: {} }) };
  }

  const rejected = await runWithOutcome("rejected");
  await assert.rejects(rejected.run, /用户拒绝了工具 clock/);
  assert.equal(rejected.ran, false);

  const unavailable = await runWithOutcome("unavailable");
  await assert.rejects(unavailable.run, /没有可用的审批通道/);
  assert.equal(unavailable.ran, false);

  const cancelled = await runWithOutcome("cancelled");
  await assert.rejects(cancelled.run, /审批被取消/);
  assert.equal(cancelled.ran, false);
});
