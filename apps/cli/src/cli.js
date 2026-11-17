/**
 * CLI 的实际逻辑：解析参数、读 .env、按 profile 挂插件、跑一轮对话。
 * 入口 index.js 只负责把进程的 argv / env / 标准流传进来，方便测试时注入假的 fetch。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { createContext } from "@hoshi/runtime";
import { createAgent } from "@hoshi/core";
import { SESSION_EVENT } from "@hoshi/session";
import { tools } from "@hoshi/tools";
import { approvals, createTerminalPrompt } from "@hoshi/approvals";
import { shellPlugin, filesystemPlugin } from "@hoshi/plugins";
import { llmDeepseek } from "@hoshi/llm-deepseek";
import {
  applyProfile,
  createDefaultProfile,
  findProfile,
  loadProfile,
} from "@hoshi/profile";

export const USAGE = `用法: hoshi [选项] <消息>

跑一轮对话：把用户消息交给已挂载的模型适配器，把助手回复打印到标准输出。

选项:
  -h, --help          显示帮助
  --model <名称>      模型，默认 deepseek-flash，或 profile 里写的 model
  --system <文本>     系统提示词，覆盖 profile 里的 system
  --profile <路径>    使用指定的 hoshi.yml；省略时读当前目录的 hoshi.yml，没有则用内置默认组合
  --no-tools          不挂载内置 shell / 文件系统工具
  --no-approvals      不挂载审批插件（shell / write / edit 会直接执行）
  --yes               自动批准本次运行中的审批（危险）

环境变量:
  HOSHI_DEEPSEEK_API_KEY   DeepSeek API 密钥（也可写在当前目录的 .env 里）

默认会挂上 shell、read、write、edit、list，工作区是当前目录。
shell、write、edit 在执行前会询问；标准输入不是终端时，没有人应答就会拒绝。
这只是审批，不是完整沙箱。

示例:
  npm run cli -- "你好"
`;

/**
 * CLI 壳提供的短名对照表。profile 只认名字，不直接依赖这些包。
 * 新增一个内置短名时改这里；项目外的插件直接在 hoshi.yml 里写模块路径即可。
 */
export const CLI_PLUGIN_CATALOG = {
  tools,
  approvals,
  shell: shellPlugin,
  filesystem: filesystemPlugin,
  "llm-deepseek": llmDeepseek,
};

/**
 * @typedef {object} CliArgs
 * @property {boolean} help
 * @property {string | undefined} model
 * @property {string | undefined} system
 * @property {string | undefined} profile
 * @property {boolean} noTools
 * @property {boolean} noApprovals
 * @property {boolean} yes
 * @property {string} message  剩余参数用空格拼成的用户消息
 */

/**
 * 把命令行参数解析成选项和消息。不认识的选项会立刻抛错。
 * @param {string[]} argv
 * @returns {CliArgs}
 */
export function parseArgs(argv) {
  const args = {
    help: false,
    model: undefined,
    system: undefined,
    profile: undefined,
    noTools: false,
    noApprovals: false,
    yes: false,
    message: "",
  };
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

    if (token === "--no-approvals") {
      args.noApprovals = true;
      continue;
    }

    if (token === "--yes") {
      args.yes = true;
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

    if (token.startsWith("--profile=")) {
      args.profile = token.slice("--profile=".length);
      continue;
    }
    if (token === "--profile") {
      args.profile = requireValue(argv, i, token);
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
 * @property {(request: import("@hoshi/approvals").ApprovalRequest) => import("@hoshi/approvals").ApprovalOutcome | Promise<import("@hoshi/approvals").ApprovalOutcome>} [prompt]
 *        测试时注入假的审批应答；正式运行时走终端提问。
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

  let profile;
  try {
    profile = await resolveCliProfile(io, args);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  profile = applyCliPluginFlags(profile, args);

  const ctx = createContext();
  const prompt = args.yes
    ? async () => "allowed-once"
    : (typeof io.prompt === "function" ? io.prompt : createTerminalPrompt(io.stdin, io.stderr));

  try {
    await applyProfile(ctx, profile, {
      catalog: CLI_PLUGIN_CATALOG,
      configure(name, config) {
        if (name === "approvals") {
          return { ...config, prompt: config.prompt ?? prompt };
        }
        if (name === "shell" || name === "filesystem") {
          return { ...config, workspace: config.workspace ?? io.cwd };
        }
        if (name === "llm-deepseek") {
          return {
            ...config,
            apiKey,
            fetch: io.fetch,
            model: args.model ?? config.model ?? profile.model,
          };
        }
        return config;
      },
    });
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const agent = createAgent(ctx, { system: args.system ?? profile.system });

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
 * --profile 优先；否则读当前目录的 hoshi.yml；再没有就用内置默认组合。
 * @param {CliIo} io
 * @param {CliArgs} args
 */
async function resolveCliProfile(io, args) {
  if (args.profile) {
    const target = path.isAbsolute(args.profile) ? args.profile : path.resolve(io.cwd, args.profile);
    return loadProfile(target);
  }
  const found = await findProfile(io.cwd);
  if (found) return loadProfile(found);
  return createDefaultProfile({ workspace: io.cwd });
}

/**
 * 命令行开关覆盖 profile：去掉对应插件，不改配置文件。
 * @param {import("@hoshi/profile").HoshiProfile} profile
 * @param {CliArgs} args
 */
export function applyCliPluginFlags(profile, args) {
  const blocked = new Set();
  if (args.noApprovals) blocked.add("approvals");
  if (args.noTools) {
    blocked.add("shell");
    blocked.add("filesystem");
  }
  if (blocked.size === 0) return profile;
  return {
    ...profile,
    plugins: profile.plugins.filter((entry) => !blocked.has(entry.plugin)),
  };
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
