import test from "node:test";
import assert from "node:assert/strict";
import { createContext } from "@hoshi/runtime";
import { tools, registerTool, runTool } from "@hoshi/tools";
import { approvals } from "@hoshi/approvals";

test("默认审批名单也会询问 mcp__ 前缀的外部工具", async () => {
  const ctx = createContext();
  const asked = [];
  ctx.plugin(tools());
  ctx.plugin(approvals({
    prompt: async (request) => {
      asked.push(request.toolName);
      return "rejected";
    },
  }));
  registerTool(ctx, {
    name: "mcp__fs__rm",
    async execute() { return "should not run"; },
  });
  await assert.rejects(() => runTool(ctx, { name: "mcp__fs__rm", arguments: {} }), /用户拒绝/);
  assert.deepEqual(asked, ["mcp__fs__rm"]);
});

test("显式传入 tools 数组时，不会自动把 mcp__ 加进询问名单", async () => {
  const ctx = createContext();
  let ran = false;
  ctx.plugin(tools());
  ctx.plugin(approvals({
    tools: ["shell"],
    prompt: async () => {
      throw new Error("不该问");
    },
  }));
  registerTool(ctx, {
    name: "mcp__fs__rm",
    async execute() {
      ran = true;
      return "ok";
    },
  });
  assert.equal(await runTool(ctx, { name: "mcp__fs__rm", arguments: {} }), "ok");
  assert.equal(ran, true);
});
