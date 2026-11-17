import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createContext } from "../packages/runtime/src/index.js";
import { createAgent } from "../packages/core/src/index.js";
import { LLM_SERVICE } from "../packages/llm/src/index.js";
import { tools } from "../packages/tools/src/index.js";
import {
  shellPlugin,
  filesystemPlugin,
  resolveInsideWorkspace,
  isInsideWorkspace,
} from "../packages/plugins/src/index.js";

async function tempWorkspace() {
  return mkdtemp(path.join(os.tmpdir(), "hoshi-plugins-"));
}

function mounted(workspace, options = {}) {
  const ctx = createContext();
  ctx.plugin(tools());
  ctx.plugin(shellPlugin({ workspace, ...options.shell }));
  ctx.plugin(filesystemPlugin({ workspace, ...options.fs }));
  return ctx;
}

function nodeCommand(source) {
  return `node -e ${JSON.stringify(source)}`;
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

test("resolveInsideWorkspace 会挡住逃出工作区的路径", async () => {
  const workspace = await tempWorkspace();
  const inside = await resolveInsideWorkspace(workspace, "sub/file.txt");
  assert.equal(inside, path.resolve(workspace, "sub/file.txt"));
  assert.equal(isInsideWorkspace(workspace, inside), true);
  await assert.rejects(() => resolveInsideWorkspace(workspace, ".."), /路径超出工作区/);
  await assert.rejects(() => resolveInsideWorkspace(workspace, path.resolve(workspace, "..", "outside.txt")), /路径超出工作区/);
});

test("符号链接如果指向工作区外，解析时会被拒绝", async (t) => {
  const workspace = await tempWorkspace();
  const outside = path.join(path.dirname(workspace), `outside-${path.basename(workspace)}.txt`);
  await writeFile(outside, "secret", "utf8");
  t.after(async () => {
    await rm(outside, { force: true });
  });
  const link = path.join(workspace, "escape.txt");
  try {
    await symlink(outside, link);
  } catch (error) {
    t.skip(`当前环境无法创建符号链接: ${error instanceof Error ? error.message : error}`);
    return;
  }
  await assert.rejects(() => resolveInsideWorkspace(workspace, "escape.txt"), /路径超出工作区/);
});

test("write、read、list、edit 在工作区内读写文本文件", async () => {
  const workspace = await tempWorkspace();
  const ctx = mounted(workspace);
  const toolsService = ctx.get("tools");

  const created = await toolsService.run({
    name: "write",
    arguments: { file_path: "notes/hello.txt", content: "hello\nworld\n" },
  });
  assert.match(String(created), /created:/);

  const listed = await toolsService.run({ name: "list", arguments: { path: "notes" } });
  assert.match(String(listed), /hello\.txt/);

  const read = await toolsService.run({
    name: "read",
    arguments: { file_path: "notes/hello.txt" },
  });
  assert.match(String(read), /lines 1-3 of 3/);
  assert.match(String(read), /1\|hello/);
  assert.match(String(read), /2\|world/);

  const edited = await toolsService.run({
    name: "edit",
    arguments: {
      file_path: "notes/hello.txt",
      old_string: "world",
      new_string: "hoshi",
    },
  });
  assert.match(String(edited), /1 replacement/);
  assert.equal(await readFile(path.join(workspace, "notes/hello.txt"), "utf8"), "hello\nhoshi\n");
});

test("read 支持按行分页，edit 在多处匹配时默认拒绝", async () => {
  const workspace = await tempWorkspace();
  const ctx = mounted(workspace);
  const toolsService = ctx.get("tools");
  await toolsService.run({
    name: "write",
    arguments: { file_path: "a.txt", content: "aaa\nbbb\naaa\n" },
  });

  const page = await toolsService.run({
    name: "read",
    arguments: { file_path: "a.txt", offset: 2, limit: 1 },
  });
  assert.match(String(page), /lines 2-2 of 4/);
  assert.match(String(page), /2\|bbb/);
  assert.doesNotMatch(String(page), /aaa/);

  await assert.rejects(
    () => toolsService.run({
      name: "edit",
      arguments: { file_path: "a.txt", old_string: "aaa", new_string: "ccc" },
    }),
    /出现了 2 次/,
  );

  await toolsService.run({
    name: "edit",
    arguments: { file_path: "a.txt", old_string: "aaa", new_string: "ccc", replace_all: true },
  });
  assert.equal(await readFile(path.join(workspace, "a.txt"), "utf8"), "ccc\nbbb\nccc\n");
});

test("文件系统工具不能读写工作区外的路径", async () => {
  const workspace = await tempWorkspace();
  const ctx = mounted(workspace);
  const toolsService = ctx.get("tools");
  await assert.rejects(
    () => toolsService.run({ name: "read", arguments: { file_path: "../secret.txt" } }),
    /路径超出工作区/,
  );
  await assert.rejects(
    () => toolsService.run({
      name: "write",
      arguments: { file_path: "../secret.txt", content: "no" },
    }),
    /路径超出工作区/,
  );
});

test("shell 能在工作区里执行命令，并挡住逃出工作区的工作目录", async () => {
  const workspace = await tempWorkspace();
  await writeFile(path.join(workspace, "marker.txt"), "ok", "utf8");
  const ctx = mounted(workspace);
  const toolsService = ctx.get("tools");

  const result = await toolsService.run({
    name: "shell",
    arguments: { command: nodeCommand("console.log('hi-from-shell')") },
  });
  assert.match(String(result), /exitCode: 0/);
  assert.match(String(result), /hi-from-shell/);

  await assert.rejects(
    () => toolsService.run({
      name: "shell",
      arguments: { command: nodeCommand("console.log(1)"), workdir: ".." },
    }),
    /路径超出工作区/,
  );
});

test("shell 超时会结束进程，并在结果里标出 timedOut", async () => {
  const workspace = await tempWorkspace();
  const ctx = mounted(workspace, { shell: { timeoutMs: 400 } });
  const result = await ctx.get("tools").run({
    name: "shell",
    arguments: { command: nodeCommand("setTimeout(() => {}, 10_000)") },
  });
  assert.match(String(result), /timedOut: true/);
});

test("挂到 createAgent 上时，模型调用 write 会真正落盘", async () => {
  const workspace = await tempWorkspace();
  const ctx = mounted(workspace);
  ctx.provide(LLM_SERVICE, fakeLlm([
    [{
      type: "tool_call",
      toolCall: { id: "call-1", name: "write", arguments: { file_path: "from-agent.txt", content: "via agent" } },
    }],
    [{ type: "text", text: "已经写好" }],
  ]));

  const agent = createAgent(ctx);
  await agent.runTurn("写一个文件");
  assert.equal(await readFile(path.join(workspace, "from-agent.txt"), "utf8"), "via agent");
  const toolMessage = agent.session.history().find((message) => message.role === "tool");
  assert.match(toolMessage.content, /created:/);
});
