import test from "node:test";
import assert from "node:assert/strict";

test("工作区各包能导出公开 API", async () => {
  const runtime = await import("@hoshi/runtime");
  const core = await import("@hoshi/core");
  const session = await import("@hoshi/session");
  const llm = await import("@hoshi/llm");
  const deepseek = await import("@hoshi/llm-deepseek");
  const openai = await import("@hoshi/llm-openai");
  const tools = await import("@hoshi/tools");
  const mcp = await import("@hoshi/mcp");
  const approvals = await import("@hoshi/approvals");
  const profile = await import("@hoshi/profile");
  const plugins = await import("@hoshi/plugins");

  assert.equal(typeof runtime.createContext, "function");
  assert.equal(typeof core.createAgent, "function");
  assert.equal(typeof core.runTurn, "function");
  assert.equal(typeof session.createSessionLog, "function");
  assert.equal(typeof session.deriveHistory, "function");
  assert.equal(typeof llm.stream, "function");
  assert.equal(llm.LLM_SERVICE, "llm");
  assert.equal(typeof deepseek.llmDeepseek, "function");
  assert.equal(typeof openai.llmOpenai, "function");
  assert.equal(typeof tools.registerTool, "function");
  assert.equal(typeof tools.runTool, "function");
  assert.equal(typeof mcp.mcp, "function");
  assert.equal(typeof approvals.approvals, "function");
  assert.equal(typeof profile.loadProfile, "function");
  assert.equal(typeof profile.applyProfile, "function");
  assert.equal(typeof plugins.shellPlugin, "function");
  assert.equal(typeof plugins.filesystemPlugin, "function");
});
