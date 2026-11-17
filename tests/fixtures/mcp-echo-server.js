/**
 * 测试用的最小 MCP stdio 服务器：实现 initialize、tools/list、tools/call。
 * SDK 2.x 的 stdio 帧是一行一条 JSON-RPC（末尾换行），不再用 Content-Length 头。
 */
import process from "node:process";

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    handleMessage(JSON.parse(line));
  }
});

/**
 * @param {Record<string, unknown>} message
 */
function handleMessage(message) {
  if (message.method === "initialize") {
    const params = /** @type {Record<string, unknown>} */ (message.params ?? {});
    reply(message.id, {
      protocolVersion: params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "hoshi-echo", version: "0.1.0" },
    });
    return;
  }
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
    return;
  }
  if (message.method === "ping") {
    reply(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    reply(message.id, {
      tools: [
        {
          name: "echo",
          description: "把 text 原样返回",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
        {
          name: "fail",
          description: "返回 isError",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    return;
  }
  if (message.method === "tools/call") {
    const params = /** @type {Record<string, unknown>} */ (message.params ?? {});
    const args = params.arguments && typeof params.arguments === "object"
      ? /** @type {Record<string, unknown>} */ (params.arguments)
      : {};
    if (params.name === "fail") {
      reply(message.id, {
        isError: true,
        content: [{ type: "text", text: "echo 服务器拒绝了这次调用" }],
      });
      return;
    }
    reply(message.id, {
      content: [{ type: "text", text: String(args.text ?? "") }],
    });
    return;
  }
  if (message.id !== undefined) {
    write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: `Method not found: ${String(message.method)}` },
    });
  }
}

/**
 * @param {unknown} id
 * @param {unknown} result
 */
function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

/**
 * @param {object} message
 */
function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
