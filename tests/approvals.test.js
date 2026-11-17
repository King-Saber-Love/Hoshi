import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createContext } from "../packages/runtime/src/index.js";
import { tools, registerTool, runTool, TOOL_EVENT, APPROVALS_SERVICE } from "../packages/tools/src/index.js";
import {
  approvals,
  createTerminalPrompt,
  parsePromptAnswer,
  formatPrompt,
  DEFAULT_ASK_TOOLS,
} from "../packages/approvals/src/index.js";

function clockTool(now = "16:21") {
  return {
    name: "clock",
    execute(args) {
      return `${now} ${args.zone ?? "UTC"}`;
    },
  };
}

function writeTool(calls) {
  return {
    name: "write",
    async execute(args) {
      calls.push(args);
      return "ok";
    },
  };
}

function withTools(plugins, extraTools = []) {
  const ctx = createContext();
  ctx.plugin(tools());
  for (const plugin of plugins) ctx.plugin(plugin);
  for (const tool of extraTools) registerTool(ctx, tool);
  return ctx;
}

test("默认会询问 shell / write / edit，read 和 list 直接放行", async () => {
  const writes = [];
  const ctx = withTools(
    [approvals({ prompt: async () => "allowed-once" })],
    [
      writeTool(writes),
      { name: "read", execute: () => "file" },
      { name: "list", execute: () => "entries" },
      { name: "shell", execute: () => "done" },
      { name: "edit", execute: () => "patched" },
    ],
  );

  assert.deepEqual(DEFAULT_ASK_TOOLS, ["shell", "write", "edit"]);
  assert.equal(await runTool(ctx, { name: "read", arguments: {} }), "file");
  assert.equal(await runTool(ctx, { name: "list", arguments: {} }), "entries");
  assert.equal(await runTool(ctx, { name: "write", arguments: { path: "a.txt" } }), "ok");
  assert.equal(await runTool(ctx, { name: "shell", arguments: { command: "echo hi" } }), "done");
  assert.equal(await runTool(ctx, { name: "edit", arguments: {} }), "patched");
  assert.deepEqual(writes, [{ path: "a.txt" }]);
});

test("没有应答函数时，需要审批的工具会被拒绝，而不是直接执行", async () => {
  const writes = [];
  const ctx = withTools([approvals()], [writeTool(writes)]);
  await assert.rejects(
    () => runTool(ctx, { name: "write", arguments: { path: "a.txt" } }),
    /没有可用的审批通道/,
  );
  assert.deepEqual(writes, []);
});

test("prompt 返回 rejected 时拒绝执行；allowed-once 则放行这一次", async () => {
  const writes = [];
  let calls = 0;
  const ctx = withTools(
    [approvals({
      prompt: async () => {
        calls += 1;
        return calls === 1 ? "rejected" : "allowed-once";
      },
    })],
    [writeTool(writes)],
  );

  await assert.rejects(
    () => runTool(ctx, { name: "write", arguments: { path: "a.txt" } }),
    /用户拒绝了工具 write/,
  );
  assert.equal(await runTool(ctx, { name: "write", arguments: { path: "b.txt" } }), "ok");
  assert.deepEqual(writes, [{ path: "b.txt" }]);
  assert.equal(calls, 2);
});

test("allowed-session 之后，同名工具本会话不必再问", async () => {
  const writes = [];
  let calls = 0;
  const ctx = withTools(
    [approvals({
      prompt: async () => {
        calls += 1;
        return "allowed-session";
      },
    })],
    [writeTool(writes)],
  );

  assert.equal(await runTool(ctx, { name: "write", arguments: { path: "a.txt" } }), "ok");
  assert.equal(await runTool(ctx, { name: "write", arguments: { path: "b.txt" } }), "ok");
  assert.equal(calls, 1);
  assert.deepEqual(writes, [{ path: "a.txt" }, { path: "b.txt" }]);
});

test("policy 为 never 时直接拒绝，不会调用 prompt", async () => {
  const writes = [];
  let called = false;
  const ctx = withTools(
    [approvals({
      policy: "never",
      prompt: async () => {
        called = true;
        return "allowed-once";
      },
    })],
    [writeTool(writes)],
  );

  await assert.rejects(
    () => runTool(ctx, { name: "write", arguments: { path: "a.txt" } }),
    /用户拒绝了工具 write/,
  );
  assert.equal(called, false);
  assert.deepEqual(writes, []);
});

test("tools: \"all\" 会连普通工具一起询问", async () => {
  let asked = "";
  const ctx = withTools(
    [approvals({
      tools: "all",
      prompt: async (request) => {
        asked = request.toolName;
        return "allowed-once";
      },
    })],
    [clockTool()],
  );

  assert.equal(await runTool(ctx, { name: "clock", arguments: { zone: "UTC" } }), "16:21 UTC");
  assert.equal(asked, "clock");
});

test("不认识的策略会在挂载时就抛错", () => {
  const ctx = createContext();
  ctx.plugin(tools());
  assert.throws(() => ctx.plugin(approvals({ policy: "always" })), /不认识的审批策略/);
});

test("预执行钩子已经返回 deny 时，审批插件不会再改成 ask", async () => {
  const writes = [];
  let prompted = false;
  const ctx = withTools(
    [approvals({
      prompt: async () => {
        prompted = true;
        return "allowed-once";
      },
    })],
    [writeTool(writes)],
  );
  ctx.on(TOOL_EVENT.PRE_EXECUTE, () => ({ kind: "deny", reason: "被其他钩子拒绝" }));

  await assert.rejects(
    () => runTool(ctx, { name: "write", arguments: { path: "a.txt" } }),
    /被其他钩子拒绝/,
  );
  assert.equal(prompted, false);
  assert.deepEqual(writes, []);
});

test("卸载审批插件后，工具恢复为直接执行", async () => {
  const writes = [];
  const ctx = createContext();
  ctx.plugin(tools());
  const uninstall = ctx.plugin(approvals({ prompt: async () => "rejected" }));
  registerTool(ctx, writeTool(writes));

  await assert.rejects(() => runTool(ctx, { name: "write", arguments: {} }), /用户拒绝/);
  uninstall();
  assert.equal(await runTool(ctx, { name: "write", arguments: { path: "a.txt" } }), "ok");
  assert.equal(ctx.get(APPROVALS_SERVICE), undefined);
});

test("parsePromptAnswer 能识别中英文，不认识的输入按拒绝处理", () => {
  assert.equal(parsePromptAnswer("y"), "allowed-once");
  assert.equal(parsePromptAnswer(" YES "), "allowed-once");
  assert.equal(parsePromptAnswer("是"), "allowed-once");
  assert.equal(parsePromptAnswer("a"), "allowed-session");
  assert.equal(parsePromptAnswer("总是"), "allowed-session");
  assert.equal(parsePromptAnswer("n"), "rejected");
  assert.equal(parsePromptAnswer(""), "rejected");
  assert.equal(parsePromptAnswer("maybe"), "rejected");
});

test("createTerminalPrompt 在非终端 stdin 上返回 unavailable", async () => {
  const stdin = Readable.from(["y\n"]);
  stdin.isTTY = false;
  const chunks = [];
  const prompt = createTerminalPrompt(stdin, { write: (chunk) => chunks.push(chunk) });
  assert.equal(await prompt({ toolName: "write", arguments: { path: "a.txt" } }), "unavailable");
  assert.deepEqual(chunks, []);
});

test("createTerminalPrompt 会把问题打到 stderr，并解析输入", async () => {
  const stdin = Readable.from(["a\n"]);
  stdin.isTTY = true;
  let output = "";
  const prompt = createTerminalPrompt(stdin, {
    write(chunk) {
      output += chunk;
    },
  });
  const outcome = await prompt({
    toolName: "write",
    arguments: { path: "a.txt" },
    reason: "工具 write 需要确认后才能执行",
  });
  assert.equal(outcome, "allowed-session");
  assert.match(output, /需要批准工具 write/);
  assert.match(output, /a\.txt/);
  assert.equal(formatPrompt({ toolName: "shell", arguments: { command: "ls" } }).includes("需要批准工具 shell"), true);
});
