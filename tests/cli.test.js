import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, applyEnvFile, resolveMessage, runCli, USAGE, applyCliPluginFlags } from "../apps/cli/src/cli.js";
import { createDefaultProfile } from "@hoshi/profile";

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

function fakeFetch(text, onRequest) {
  return async (url, init) => {
    if (onRequest) onRequest(url, init);
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sseText(text)));
          controller.close();
        },
      }),
    };
  };
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

test("parseArgs 能识别 --profile 和 --profile=", () => {
  assert.equal(parseArgs(["--profile", "./hoshi.yml", "你好"]).profile, "./hoshi.yml");
  assert.equal(parseArgs(["--profile=custom.yml", "你好"]).profile, "custom.yml");
  assert.throws(() => parseArgs(["--profile"]), /--profile 后面需要一个值/);
});

test("USAGE 会说明审批相关选项和 --profile", () => {
  assert.match(USAGE, /--no-approvals/);
  assert.match(USAGE, /--yes/);
  assert.match(USAGE, /--profile/);
});

test("applyCliPluginFlags 会按开关去掉对应插件", () => {
  const profile = applyCliPluginFlags(createDefaultProfile(), { noTools: true, noApprovals: true });
  assert.deepEqual(profile.plugins.map((entry) => entry.plugin), ["tools", "llm-deepseek"]);
});

test("当前目录的 hoshi.yml 会提供 system，--system 可以覆盖它", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "hoshi-cli-"));
  await writeFile(path.join(cwd, "hoshi.yml"), "system: 来自 profile\nplugins:\n  - plugin: tools\n  - plugin: llm-deepseek\n", "utf8");

  let fromProfile;
  const captured = io({
    argv: ["你好"],
    cwd,
    env: { HOSHI_DEEPSEEK_API_KEY: "test-key" },
    fetch: fakeFetch("ok", (_url, init) => {
      fromProfile = JSON.parse(init.body);
    }),
  });
  assert.equal(await runCli(captured), 0);
  assert.equal(fromProfile.system, "来自 profile");

  let fromFlag;
  const overridden = io({
    argv: ["--system", "来自命令行", "你好"],
    cwd,
    env: { HOSHI_DEEPSEEK_API_KEY: "test-key" },
    fetch: fakeFetch("ok", (_url, init) => {
      fromFlag = JSON.parse(init.body);
    }),
  });
  assert.equal(await runCli(overridden), 0);
  assert.equal(fromFlag.system, "来自命令行");
});

test("--profile 指向不存在的文件时以用法错误退出", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "hoshi-cli-"));
  const captured = io({
    argv: ["--profile", "missing.yml", "你好"],
    cwd,
    env: { HOSHI_DEEPSEEK_API_KEY: "test-key" },
    fetch: async () => {
      throw new Error("不该发请求");
    },
  });
  const code = await runCli(captured);
  assert.equal(code, 1);
  assert.match(captured.captured().stderr, /找不到 profile/);
});

test("非法的 hoshi.yml 会以用法错误退出", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "hoshi-cli-"));
  await writeFile(path.join(cwd, "hoshi.yml"), "plugins: {\n", "utf8");
  const captured = io({
    argv: ["你好"],
    cwd,
    env: { HOSHI_DEEPSEEK_API_KEY: "test-key" },
    fetch: async () => {
      throw new Error("不该发请求");
    },
  });
  const code = await runCli(captured);
  assert.equal(code, 1);
  assert.match(captured.captured().stderr, /无法解析 profile YAML/);
});

test("CLI 的插件对照表里有 mcp", async () => {
  const { CLI_PLUGIN_CATALOG } = await import("../apps/cli/src/cli.js");
  assert.equal(typeof CLI_PLUGIN_CATALOG.mcp, "function");
});
