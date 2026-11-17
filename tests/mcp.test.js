import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext } from "@hoshi/runtime";
import { tools, runTool } from "@hoshi/tools";
import {
  mcp,
  publicToolName,
  formatMcpResult,
  resolveConfig,
  MCP_TOOL_PREFIX,
  SERVER_NAME_PATTERN,
} from "@hoshi/mcp";

const fixtureServer = fileURLToPath(new URL("./fixtures/mcp-echo-server.js", import.meta.url));

test("publicToolName 在干净情况下就是 mcp__server__raw", () => {
  assert.equal(MCP_TOOL_PREFIX, "mcp__");
  assert.equal(publicToolName("fs", "read_file"), "mcp__fs__read_file");
  assert.match("fs", SERVER_NAME_PATTERN);
});

test("公开名遇到非法字符或超长时，会截断并带上哈希，避免撞名", () => {
  const hashed = publicToolName("fs", "read.file");
  const digest = createHash("sha256").update("fs\0read.file").digest("hex").slice(0, 12);
  assert.ok(hashed.endsWith(`_${digest}`));
  assert.ok(hashed.length <= 64);
  assert.notEqual(publicToolName("fs", "read.file"), publicToolName("fs", "read/file"));
});

test("formatMcpResult 会拼接文本，并用占位符说明不支持的内容", () => {
  assert.equal(formatMcpResult({
    content: [
      { type: "text", text: "hello" },
      { type: "image", mimeType: "image/png" },
    ],
  }, "echo"), "hello\n[图片结果暂不支持: image/png]");
  assert.equal(formatMcpResult({ content: [] }, "echo"), "（echo 没有返回模型可见的内容）");
  assert.equal(formatMcpResult({ content: [], structuredContent: { ok: true } }, "echo"), "{\"ok\":true}");
});

test("resolveConfig 会校验 serverName、传输和必填字段", () => {
  assert.throws(() => resolveConfig({}), /需要 serverName/);
  assert.throws(() => resolveConfig({ serverName: "bad name" }), /serverName 只能是/);
  assert.throws(() => resolveConfig({ serverName: "fs" }), /需要 transport/);
  assert.throws(() => resolveConfig({ serverName: "fs", transport: "stdio" }), /需要 command/);
  assert.throws(() => resolveConfig({ serverName: "web", transport: "http" }), /需要 url/);
  assert.throws(() => resolveConfig({ serverName: "web", url: "not-a-url" }), /不是合法地址/);
  const http = resolveConfig({ serverName: "web", transport: "streamable-http", url: "https://example.com/mcp" });
  assert.equal(http.transport, "http");
  assert.equal(resolveConfig({ serverName: "fs", command: "npx" }).transport, "stdio");
});

function fakeClient(handlers) {
  return {
    async listTools() {
      return handlers.listTools();
    },
    async callTool(params, options) {
      return handlers.callTool(params, options);
    },
    async close() {
      handlers.closed = (handlers.closed ?? 0) + 1;
    },
  };
}

test("挂上后会把发现的工具登记到管线，公开名带服务器前缀", async () => {
  const ctx = createContext();
  const calls = [];
  ctx.plugin(tools());
  const uninstall = await ctx.plugin(mcp({
    serverName: "demo",
    client: fakeClient({
      listTools: () => ({
        tools: [
          { name: "echo", description: "回声", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
        ],
      }),
      callTool: (params, options) => {
        calls.push({ params, options });
        return { content: [{ type: "text", text: `got:${params.arguments.text}` }] };
      },
    }),
  }));

  const listed = ctx.get("tools").list();
  assert.deepEqual(listed.map((item) => item.name), ["mcp__demo__echo"]);
  assert.equal(listed[0].description, "回声");

  const result = await runTool(ctx, { name: "mcp__demo__echo", arguments: { text: "hi" } });
  assert.equal(result, "got:hi");
  assert.equal(calls[0].params.name, "echo");
  assert.equal(calls[0].options.timeout, 60_000);

  uninstall();
  assert.equal(ctx.get("tools").list().length, 0);
});

test("MCP 返回 isError 时，工具调用会抛出对应文本", async () => {
  const ctx = createContext();
  ctx.plugin(tools());
  await ctx.plugin(mcp({
    serverName: "demo",
    client: fakeClient({
      listTools: () => ({ tools: [{ name: "fail", inputSchema: { type: "object", properties: {} } }] }),
      callTool: () => ({ isError: true, content: [{ type: "text", text: "上游失败" }] }),
    }),
  }));
  await assert.rejects(() => runTool(ctx, { name: "mcp__demo__fail", arguments: {} }), /上游失败/);
});

test("同一上下文里不能重复占用同一个 serverName", async () => {
  const ctx = createContext();
  ctx.plugin(tools());
  const client = fakeClient({ listTools: () => ({ tools: [] }), callTool: () => ({ content: [] }) });
  await ctx.plugin(mcp({ serverName: "demo", client }));
  await assert.rejects(
    () => ctx.plugin(mcp({ serverName: "demo", client })),
    /服务器名 "demo" 已经在使用/,
  );
});

test("没有先挂 tools、或 listTools 失败且 failOnStartupError 为真时，会抛错", async () => {
  const ctx = createContext();
  await assert.rejects(
    () => ctx.plugin(mcp({ serverName: "demo", client: fakeClient({ listTools: async () => ({ tools: [] }), callTool: async () => ({}) }) })),
    /请先挂载 tools 插件/,
  );

  const withTools = createContext();
  withTools.plugin(tools());
  await assert.rejects(
    () => ctx.plugin === undefined
      ? Promise.resolve()
      : withTools.plugin(mcp({
        serverName: "demo",
        client: fakeClient({
          listTools: async () => {
            throw new Error("boom");
          },
          callTool: async () => ({}),
        }),
      })),
    /连接 MCP 服务器 "demo" 失败: boom/,
  );
});

test("failOnStartupError 为 false 时，启动失败不会把插件打崩，只是没有工具", async () => {
  const ctx = createContext();
  ctx.plugin(tools());
  await ctx.plugin(mcp({
    serverName: "demo",
    failOnStartupError: false,
    client: fakeClient({
      listTools: async () => {
        throw new Error("offline");
      },
      callTool: async () => ({}),
    }),
  }));
  assert.equal(ctx.get("tools").list().length, 0);
});

test("能通过 stdio 连上真实的回声服务器，并调用 echo / fail", async () => {
  const ctx = createContext();
  ctx.plugin(tools());
  const uninstall = await ctx.plugin(mcp({
    transport: "stdio",
    serverName: "echo",
    command: process.execPath,
    args: [fixtureServer],
  }));

  const names = ctx.get("tools").list().map((item) => item.name).sort();
  assert.deepEqual(names, ["mcp__echo__echo", "mcp__echo__fail"]);

  const echoed = await runTool(ctx, { name: "mcp__echo__echo", arguments: { text: "ping" } });
  assert.equal(echoed, "ping");
  await assert.rejects(
    () => runTool(ctx, { name: "mcp__echo__fail", arguments: {} }),
    /echo 服务器拒绝了这次调用/,
  );

  uninstall();
  assert.equal(ctx.get("tools").list().length, 0);
});
