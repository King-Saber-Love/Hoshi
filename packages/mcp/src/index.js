/**
 * MCP 客户端插件。连上一个 MCP 服务器，把它发现的工具登记进 Hoshi 的工具管线。
 *
 * 和官方一样：一个插件实例对应一台服务器；要接多台，就在 hoshi.yml 里挂多次。
 * 模型看到的工具名是 `mcp__<serverName>__<原名>`，避免和内置 shell / write 撞名。
 *
 * 传输支持 stdio（拉起子进程）和 HTTP（Streamable HTTP）。
 * 这一步不做官方那种自动重连、凭证模板和资源订阅。
 */

import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { registerTool } from "@hoshi/tools";

/** 公开工具名的前缀，审批插件默认也会拦截这个前缀。 */
export const MCP_TOOL_PREFIX = "mcp__";

/** 官方同一套规则：serverName 只允许字母数字、下划线和连字符，最长 32。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** DeepSeek 函数名限制：最多 64 个字符，且只能是 [A-Za-z0-9_-]。 */
const MAX_PUBLIC_NAME_LENGTH = 64;
const HASH_LENGTH = 12;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;

const CLIENT_INFO = { name: "hoshi", version: "0.1.0" };

/** 同一上下文里已经占用的 serverName，避免两台服务器抢同一段前缀。 */
const reservedServerNames = new WeakMap();

/**
 * 把 MCP 服务器的原始工具名，变成模型看到的公开名。
 * 干净情况下就是 `mcp__<serverName>__<rawName>`；如果替换非法字符或截断，
 * 会再拼上 12 位哈希，避免两个不同的原名被折成同一个公开名。
 *
 * @param {string} serverName
 * @param {string} rawName
 * @returns {string}
 */
export function publicToolName(serverName, rawName) {
  const joined = `${MCP_TOOL_PREFIX}${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_NAME_CHARS, "_");
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) {
    return normalized;
  }
  const hash = createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}

/**
 * 把 MCP 的 tools/call 结果收成模型能读的文本。
 * 图片、音频、资源先用占位说明，Hoshi 还没有附件通道。
 *
 * @param {unknown} result
 * @param {string} rawName
 * @returns {string}
 */
export function formatMcpResult(result, rawName) {
  const record = result && typeof result === "object" ? /** @type {Record<string, unknown>} */ (result) : {};
  const text = extractText(record.content, rawName);
  if (record.structuredContent !== undefined && looksEmpty(text, rawName)) {
    try {
      return JSON.stringify(record.structuredContent);
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * 创建 MCP 插件。挂载时是异步的：先连上服务器、拉工具列表，再登记到管线。
 * `applyProfile` / `ctx.plugin` 会等到这一步完成。
 *
 * @param {object} [config]
 * @param {"stdio" | "http" | "streamable-http"} [config.transport]
 * @param {string} [config.serverName]
 * @param {string} [config.command]  stdio：可执行文件
 * @param {string[]} [config.args]
 * @param {Record<string, string>} [config.env]
 * @param {string} [config.cwd]
 * @param {string} [config.url]  HTTP：服务端点
 * @param {Record<string, string>} [config.headers]
 * @param {number} [config.toolCallTimeoutMs]
 * @param {number} [config.startupTimeoutMs]
 * @param {boolean} [config.failOnStartupError]
 * @param {{ listTools: Function, callTool: Function, close?: Function }} [config.client]  测试时可注入假客户端
 * @returns {import("@hoshi/runtime").HoshiPlugin}
 */
export function mcp(config = {}) {
  const resolved = resolveConfig(config);

  /**
   * @param {import("@hoshi/runtime").HoshiContext} ctx
   */
  return async function mcpPlugin(ctx) {
    if (!ctx.get("tools")) {
      throw new Error("请先挂载 tools 插件，再挂载 mcp");
    }

    reserveServerName(ctx, resolved.serverName);

    let client;
    let closed = false;
    const closeClient = async () => {
      if (closed) return;
      closed = true;
      if (client && typeof client.close === "function") {
        try {
          await client.close();
        } catch {
          // 卸载时再关一次失败就忽略，避免挡住插件清理。
        }
      }
    };

    // effect 的清理函数是同步调用的，这里只能发起关闭，不能 await。
    ctx.effect(() => () => {
      closeClient();
    });

    try {
      client = resolved.client ?? await openClient(resolved);
      const listed = await withTimeout(
        client.listTools(),
        resolved.startupTimeoutMs,
        `连接 MCP 服务器 "${resolved.serverName}" 超时`,
      );
      const tools = Array.isArray(listed?.tools) ? listed.tools : [];
      registerDiscoveredTools(ctx, client, resolved, tools);
    } catch (error) {
      await closeClient();
      if (resolved.failOnStartupError) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`连接 MCP 服务器 "${resolved.serverName}" 失败: ${reason}`, { cause: error });
      }
    }
  };
}

export default mcp;

/**
 * @param {object} config
 */
export function resolveConfig(config) {
  if (config == null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("mcp(config) 需要一个配置对象");
  }

  const serverName = typeof config.serverName === "string" ? config.serverName.trim() : "";
  if (!serverName) {
    throw new Error("mcp 需要 serverName");
  }
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new Error(`mcp 的 serverName 只能是 1 到 32 位字母、数字、下划线或连字符，收到的是 "${serverName}"`);
  }

  let transport = config.transport;
  if (transport === "streamable-http") transport = "http";
  if (transport === undefined) {
    if (config.client) transport = "injected";
    else if (typeof config.command === "string" && config.command) transport = "stdio";
    else if (typeof config.url === "string" && config.url) transport = "http";
    else throw new Error("mcp 需要 transport: \"stdio\" 或 \"http\"，也可以直接提供 command 或 url");
  }
  if (transport !== "stdio" && transport !== "http" && transport !== "injected") {
    throw new Error(`不认识的 MCP 传输: ${String(transport)}`);
  }

  if (transport === "stdio" && (typeof config.command !== "string" || !config.command)) {
    throw new Error("stdio 传输需要 command");
  }
  if (transport === "http") {
    if (typeof config.url !== "string" || !config.url) {
      throw new Error("http 传输需要 url");
    }
    try {
      // 只做格式校验，真正的请求在挂载时才发出。
      // eslint-disable-next-line no-new
      new URL(config.url);
    } catch {
      throw new Error(`mcp 的 url 不是合法地址: ${config.url}`);
    }
  }

  if (config.args !== undefined && !Array.isArray(config.args)) {
    throw new Error("mcp 的 args 必须是字符串数组");
  }
  if (config.env !== undefined && (config.env == null || typeof config.env !== "object" || Array.isArray(config.env))) {
    throw new Error("mcp 的 env 必须是对象");
  }
  if (config.headers !== undefined && (config.headers == null || typeof config.headers !== "object" || Array.isArray(config.headers))) {
    throw new Error("mcp 的 headers 必须是对象");
  }

  return {
    transport,
    serverName,
    command: config.command,
    args: Array.isArray(config.args) ? config.args.map(String) : [],
    env: { ...(config.env ?? {}) },
    cwd: typeof config.cwd === "string" && config.cwd ? config.cwd : undefined,
    url: config.url,
    headers: { ...(config.headers ?? {}) },
    toolCallTimeoutMs: optionalPositiveNumber(config.toolCallTimeoutMs, "toolCallTimeoutMs", 60_000),
    startupTimeoutMs: optionalPositiveNumber(config.startupTimeoutMs, "startupTimeoutMs", undefined),
    failOnStartupError: config.failOnStartupError !== false,
    client: config.client,
  };
}

/**
 * @param {import("@hoshi/runtime").HoshiContext} ctx
 * @param {string} serverName
 */
function reserveServerName(ctx, serverName) {
  let names = reservedServerNames.get(ctx);
  if (!names) {
    names = new Set();
    reservedServerNames.set(ctx, names);
  }
  if (names.has(serverName)) {
    throw new Error(`MCP 服务器名 "${serverName}" 已经在使用，同一上下文里不能重复`);
  }
  names.add(serverName);
  ctx.effect(() => () => {
    names.delete(serverName);
  });
}

/**
 * @param {ReturnType<typeof resolveConfig>} resolved
 */
async function openClient(resolved) {
  const transport = createTransport(resolved);
  if (resolved.transport === "stdio" && transport.stderr && typeof transport.stderr.resume === "function") {
    // stderr 默认 pipe，不读的话子进程写满缓冲区会卡住。
    transport.stderr.resume();
  }
  const client = new Client(CLIENT_INFO);
  await withTimeout(
    client.connect(transport),
    resolved.startupTimeoutMs,
    `连接 MCP 服务器 "${resolved.serverName}" 超时`,
  );
  return client;
}

/**
 * @param {ReturnType<typeof resolveConfig>} resolved
 */
function createTransport(resolved) {
  if (resolved.transport === "stdio") {
    return new StdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: { ...getDefaultEnvironment(), ...resolved.env },
      cwd: resolved.cwd,
      stderr: "pipe",
    });
  }
  return new StreamableHTTPClientTransport(
    new URL(resolved.url),
    { requestInit: { headers: resolved.headers } },
  );
}

/**
 * @param {import("@hoshi/runtime").HoshiContext} ctx
 * @param {{ callTool: Function }} client
 * @param {ReturnType<typeof resolveConfig>} resolved
 * @param {Array<{ name?: string, description?: string, inputSchema?: object }>} tools
 */
function registerDiscoveredTools(ctx, client, resolved, tools) {
  const seenRaw = new Set();
  const seenPublic = new Set();

  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || !tool.name) {
      throw new Error(`MCP 服务器 "${resolved.serverName}" 返回了没有名字的工具`);
    }
    if (seenRaw.has(tool.name)) {
      throw new Error(`MCP 服务器 "${resolved.serverName}" 返回了重复的工具名: ${tool.name}`);
    }
    seenRaw.add(tool.name);

    const publicName = publicToolName(resolved.serverName, tool.name);
    if (seenPublic.has(publicName)) {
      throw new Error(`MCP 服务器 "${resolved.serverName}" 的工具映射后重名: ${publicName}`);
    }
    seenPublic.add(publicName);

    const rawName = tool.name;
    registerTool(ctx, {
      name: publicName,
      description: typeof tool.description === "string" ? tool.description : undefined,
      schema: tool.inputSchema ?? { type: "object", properties: {} },
      async execute(args) {
        const result = await client.callTool(
          { name: rawName, arguments: args && typeof args === "object" ? args : {} },
          { timeout: resolved.toolCallTimeoutMs },
        );
        if (result && result.isError === true) {
          throw new Error(formatMcpResult(result, rawName));
        }
        return formatMcpResult(result, rawName);
      },
    });
  }
}

/**
 * @param {Promise<unknown>} promise
 * @param {number | undefined} ms
 * @param {string} message
 */
async function withTimeout(promise, ms, message) {
  if (ms === undefined) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {number | undefined} fallback
 * @returns {number | undefined}
 */
function optionalPositiveNumber(value, field, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`mcp 的 ${field} 必须是正数`);
  }
  return value;
}

/**
 * @param {unknown} content
 * @param {string} rawName
 * @returns {string}
 */
function extractText(content, rawName) {
  const blocks = Array.isArray(content) ? content : [];
  const lines = [];
  for (const value of blocks) {
    if (value == null || typeof value !== "object") {
      lines.push("[不支持的 MCP 内容块：期望一个对象]");
      continue;
    }
    const block = /** @type {Record<string, unknown>} */ (value);
    switch (block.type) {
      case "text":
        if (typeof block.text === "string") lines.push(block.text);
        break;
      case "image":
        lines.push(`[图片结果暂不支持: ${typeof block.mimeType === "string" ? block.mimeType : "未知类型"}]`);
        break;
      case "audio":
        lines.push(`[音频结果暂不支持: ${typeof block.mimeType === "string" ? block.mimeType : "未知类型"}]`);
        break;
      case "resource_link":
        if (typeof block.name === "string" && typeof block.uri === "string") {
          lines.push(`资源链接: ${block.name} (${block.uri})`);
        } else {
          lines.push("[资源链接不可用：缺少 name 或 uri]");
        }
        break;
      case "resource":
        lines.push("[内嵌资源暂不支持]");
        break;
      default:
        lines.push(`[不支持的 MCP 内容类型: ${String(block.type)}]`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : `（${rawName} 没有返回模型可见的内容）`;
}

/**
 * @param {string} text
 * @param {string} rawName
 */
function looksEmpty(text, rawName) {
  return text === `（${rawName} 没有返回模型可见的内容）`;
}
