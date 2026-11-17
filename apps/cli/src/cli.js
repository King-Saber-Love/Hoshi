/**
 * CLI 的实际逻辑：解析参数、读 .env、挂上运行时、工具管线和 DeepSeek 适配器、跑一轮对话。
 * 入口 index.js 只负责把进程的 argv / env / 标准流传进来，方便测试时注入假的 fetch。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createContext } from "@hoshi/runtime";
import { createAgent } from "@hoshi/core";
import { SESSION_EVENT } from "@hoshi/session";
import { tools } from "@hoshi/tools";
import { shellPlugin, filesystemPlugin } from "@hoshi/plugins";
import { llmDeepseek } from "@hoshi/llm-deepseek";

export const USAGE = `用法: hoshi [选项] <消息>

跑一轮对话：把用户消息交给已挂载的 DeepSeek 适配器，把助手回复打印到标准输出。

选项:
  -h, --help          显示帮助
  --model <名称>      模型，默认 deepseek-flash
  --system <文本>     系统提示词
  --no-tools          不挂载内置 shell / 文件系统工具

环境变量:
  HOSHI_DEEPSEEK_API_KEY   DeepSeek API 密钥（也可写在当前目录的 .env 里）

默认会挂上 shell、read、write、edit、list，工作区是当前目录。还没有审批，也不是完整沙箱。

示例:
  npm run cli -- "你好"
`;

/**
 * @typedef {object} CliArgs
 * @property {boolean} help
 * @property {string | undefined} model
 * @property {string | undefined} system
 * @property {boolean} noTools
 * @property {string} message  剩余参数用空格拼成的用户消息
 */

/**
 * 把命令行参数解析成选项和消息。不认识的选项会立刻抛错。
 * @param {string[]} argv
 * @returns {CliArgs}
 */
export function parseArgs(argv) {
  const args = { help: false, model: undefined, system: undefined, noTools: false, message: "" };
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }

    if (token === "--no-tools") {
      args.noTools = true;
      continue;
    }

    if (token === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith("--model=")) {
      args.model = token.slice("--model=".length);
      continue;
    }
    if (token === "--model") {
      args.model = requireValue(argv, i, token);
      i += 1;
      continue;
    }

    if (token.startsWith("--system=")) {
      args.system = token.slice("--system=".length);
      continue;
    }
    if (token === "--system") {
      args.system = requireValue(argv, i, token);
      i += 1;
      continue;
    }

    if (token.startsWith("-")) {
      throw new Error(`不认识的选项: ${token}`);
    }

    rest.push(token);
  }

  args.message = rest.join(" ").trim();
  return args;
}

/**
 * @param {string[]} argv
 * @param {number} index 选项本身所在的下标
 * @param {string} flag
 * @returns {string}
 */
function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} 后面需要一个值`);
  }
  return value;
}

/**
 * 把当前目录里的 .env 补进 env。已经存在的变量不会被覆盖。
 * 只认识 KEY=VALUE，行首 # 是注释；不引入额外依赖。
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 */
export async function applyEnvFile(env, cwd) {
  const file = path.join(cwd, ".env");
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = cleaned.indexOf("=");
    if (eq <= 0) continue;
    const key = cleaned.slice(0, eq).trim();
    if (!key || env[key] !== undefined) continue;
    env[key] = unquote(cleaned.slice(eq + 1).trim());
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function unquote(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 如果命令行没给消息，且标准输入不是终端（例如管道），就从 stdin 读。
 * @param {string} message
 * @param {NodeJS.ReadableStream | undefined} stdin
 * @returns {Promise<string>}
 */
export async function resolveMessage(message, stdin) {
  if (message) return message;
  if (!stdin || stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("").trim();
}

/**
 * @typedef {object} CliIo
 * @property {string[]} argv
 * @property {NodeJS.ProcessEnv} env
 * @property {string} cwd
 * @property {NodeJS.ReadableStream} [stdin]
 * @property {{ write: (chunk: string) => unknown }} stdout
 * @property {{ write: (chunk: string) => unknown }} stderr
 * @property {typeof fetch} [fetch] 测试时注入假的 fetch，不会真的访问网络
 */

/**
 * 跑完 CLI 的一次调用，返回进程退出码：0 成功，1 用法错误，2 运行失败。
 * @param {CliIo} io
 * @returns {Promise<number>}
 */
export async function runCli(io) {
  let args;
  try {
    args = parseArgs(io.argv);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 1;
  }

  if (args.help) {
    io.stdout.write(USAGE);
    return 0;
  }

  await applyEnvFile(io.env, io.cwd);
  const input = await resolveMessage(args.message, io.stdin);
  if (!input) {
    io.stderr.write(`请提供一条用户消息。\n\n${USAGE}`);
    return 1;
  }

  const apiKey = io.env.HOSHI_DEEPSEEK_API_KEY;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    io.stderr.write("缺少 DeepSeek API Key，请设置 HOSHI_DEEPSEEK_API_KEY，或在当前目录的 .env 里填写。\n");
    return 2;
  }

  const ctx = createContext();
  ctx.plugin(tools());
  if (!args.noTools) {
    ctx.plugin(shellPlugin({ workspace: io.cwd }));
    ctx.plugin(filesystemPlugin({ workspace: io.cwd }));
  }
  ctx.plugin(llmDeepseek({
    apiKey,
    model: args.model,
    fetch: io.fetch,
  }));

  const agent = createAgent(ctx, { system: args.system });

  try {
    await agent.runTurn(input);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const reply = lastAssistantText(agent.session);
  if (reply) {
    io.stdout.write(reply.endsWith("\n") ? reply : `${reply}\n`);
  }

  const status = lastTurnStatus(agent.session);
  if (status && status !== "completed") {
    io.stderr.write(`本轮以 ${status} 结束。\n`);
    return 2;
  }

  return 0;
}

/**
 * 取出本轮里、最后一条用户消息之后的助手文本。
 * @param {import("@hoshi/session").SessionLog} session
 * @returns {string}
 */
function lastAssistantText(session) {
  const history = session.history();
  let lastUser = -1;
  for (let i = 0; i < history.length; i += 1) {
    if (history[i].role === "user") lastUser = i;
  }
  return history
    .slice(lastUser + 1)
    .filter((item) => item.role === "assistant" && typeof item.content === "string" && item.content)
    .map((item) => item.content)
    .join("\n\n");
}

/**
 * @param {import("@hoshi/session").SessionLog} session
 * @returns {string | undefined}
 */
function lastTurnStatus(session) {
  const events = session.events();
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === SESSION_EVENT.TURN_END) {
      const status = events[i].payload?.status;
      return typeof status === "string" ? status : undefined;
    }
  }
  return undefined;
}
