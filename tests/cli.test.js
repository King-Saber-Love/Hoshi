import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, applyEnvFile, resolveMessage, runCli, USAGE } from "../apps/cli/src/cli.js";

function sseText(text) {
  const events = [
    { event: "message_start", data: { type: "message_start", message: { id: "m1", role: "assistant", content: [] } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ];
  return `${events
    .map((item) => `event: ${item.event}\ndata: ${JSON.stringify(item.data)}`)
    .join("\n\n")}\n\n`;
}

function fakeFetch(text) {
  return async () => ({
    ok: true,
    status: 200,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sseText(text)));
        controller.close();
      },
    }),
  });
}

function io(overrides = {}) {
  let stdout = "";
  let stderr = "";
  return {
    argv: [],
    env: {},
    cwd: os.tmpdir(),
    stdout: { write(chunk) { stdout += chunk; } },
    stderr: { write(chunk) { stderr += chunk; } },
    ...overrides,
    captured() {
      return { stdout, stderr };
    },
  };
}

test("parseArgs 会把剩余参数拼成一条消息，并识别 --model 和 --system", () => {
  const args = parseArgs(["--model", "deepseek-v4-pro", "--system", "你是助手", "你好", "Hoshi"]);
  assert.equal(args.help, false);
  assert.equal(args.model, "deepseek-v4-pro");
  assert.equal(args.system, "你是助手");
  assert.equal(args.message, "你好 Hoshi");
});

test("parseArgs 支持 --model= 这种写法，以及 -- 之后的内容都当作消息", () => {
  const args = parseArgs(["--model=deepseek-flash", "--", "--help", "还是消息"]);
  assert.equal(args.model, "deepseek-flash");
  assert.equal(args.message, "--help 还是消息");
});

test("不认识的选项会抛错", () => {
  assert.throws(() => parseArgs(["--unknown"]), /不认识的选项: --unknown/);
  assert.throws(() => parseArgs(["--model"]), /--model 后面需要一个值/);
});

test("applyEnvFile 会补上尚未设置的变量，但不覆盖已有值", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "hoshi-cli-"));
  await writeFile(path.join(cwd, ".env"), "HOSHI_DEEPSEEK_API_KEY=from-file\nOTHER=ok\n", "utf8");
  const env = { HOSHI_DEEPSEEK_API_KEY: "from-env" };
  await applyEnvFile(env, cwd);
  assert.equal(env.HOSHI_DEEPSEEK_API_KEY, "from-env");
  assert.equal(env.OTHER, "ok");
});

test("没有消息且 stdin 是终端时，resolveMessage 返回空字符串", async () => {
  const empty = await resolveMessage("", { isTTY: true, async *[Symbol.asyncIterator]() {} });
  assert.equal(empty, "");
});

test("stdin 不是终端时，会把管道内容当作消息", async () => {
  const stdin = {
    isTTY: false,
    async *[Symbol.asyncIterator]() {
      yield "从管道来的话";
    },
  };
  assert.equal(await resolveMessage("", stdin), "从管道来的话");
});

test("--help 会打印用法并成功退出，不检查密钥", async () => {
  const captured = io({ argv: ["--help"] });
  const code = await runCli(captured);
  assert.equal(code, 0);
  assert.equal(captured.captured().stdout, USAGE);
  assert.equal(captured.captured().stderr, "");
});

test("没有消息时以用法错误退出", async () => {
  const captured = io({ argv: [], stdin: { isTTY: true, async *[Symbol.asyncIterator]() {} } });
  const code = await runCli(captured);
  assert.equal(code, 1);
  assert.match(captured.captured().stderr, /请提供一条用户消息/);
});

test("缺少 API Key 时立刻失败，不会发请求", async () => {
  let called = 0;
  const captured = io({
    argv: ["你好"],
    env: {},
    fetch: async () => {
      called += 1;
      throw new Error("不该发请求");
    },
  });
  const code = await runCli(captured);
  assert.equal(code, 2);
  assert.equal(called, 0);
  assert.match(captured.captured().stderr, /HOSHI_DEEPSEEK_API_KEY/);
});

test("能挂上适配器跑完一轮，并把助手回复打到标准输出", async () => {
  const captured = io({
    argv: ["--system", "你是助手", "你好"],
    env: { HOSHI_DEEPSEEK_API_KEY: "test-key" },
    fetch: fakeFetch("你好，我是 Hoshi。"),
  });
  const code = await runCli(captured);
  assert.equal(code, 0);
  assert.equal(captured.captured().stdout, "你好，我是 Hoshi。\n");
  assert.equal(captured.captured().stderr, "");
});

test("模型报错时把错误打到标准错误，退出码为 2", async () => {
  const captured = io({
    argv: ["你好"],
    env: { HOSHI_DEEPSEEK_API_KEY: "test-key" },
    fetch: async () => ({
      ok: false,
      status: 401,
      async text() { return "{\"error\":{\"message\":\"invalid api key\"}}"; },
      async json() { return { error: { message: "invalid api key" } }; },
    }),
  });
  const code = await runCli(captured);
  assert.equal(code, 2);
  assert.equal(captured.captured().stdout, "");
  assert.match(captured.captured().stderr, /invalid api key|401/);
});

test("parseArgs 能识别 --no-tools", () => {
  const args = parseArgs(["--no-tools", "你好"]);
  assert.equal(args.noTools, true);
  assert.equal(args.message, "你好");
});

test("parseArgs 能识别 --no-approvals 和 --yes", () => {
  const args = parseArgs(["--no-approvals", "--yes", "你好"]);
  assert.equal(args.noApprovals, true);
  assert.equal(args.yes, true);
  assert.equal(args.message, "你好");
});

test("USAGE 会说明审批相关选项", () => {
  assert.match(USAGE, /--no-approvals/);
  assert.match(USAGE, /--yes/);
});
