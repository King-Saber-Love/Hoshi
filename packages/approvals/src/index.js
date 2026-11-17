/**
 * 审批插件：决定哪些工具需要先问再跑，并提供一个可替换的应答通道。
 *
 * 它做两件事，都不改核心循环：
 * 1. 监听 tools/pre-execute，把名单里的工具从 allow 改成 ask；
 * 2. provide("approvals", { request })，供工具管线在遇到 ask 时来问结果。
 *
 * 没有应答函数时是 fail closed：request 返回 unavailable，管线会拒绝这次调用。
 * policy 为 never 时不会问人，直接拒绝，适合不能交互的环境。
 */

import { Writable } from "node:stream";
import { TOOL_EVENT } from "@hoshi/tools";

/** 挂到上下文上的服务名，工具管线通过 ctx.get("approvals") 找到它。 */
export const APPROVALS_SERVICE = "approvals";

/** 向应答函数发问时使用的事件名。 */
export const APPROVAL_EVENT = {
  REQUEST: "approvals/request",
};

/** 默认需要询问的工具：会改环境或写文件的那几个。read / list 默认放行。 */
/** 默认要询问的工具名。名字以 mcp__ 开头的外部工具，在未显式指定 tools 时也会问。 */
export const DEFAULT_ASK_TOOLS = ["shell", "write", "edit"];

/** @typedef {"ask" | "never"} ApprovalPolicy */
export const APPROVAL_POLICIES = /** @type {const} */ (["ask", "never"]);

/**
 * 一次审批的结果。
 * - allowed-once：只放行这一次
 * - allowed-session：放行这一次，并且本会话里同名工具不必再问
 * - rejected：用户拒绝
 * - cancelled：问的过程被取消
 * - unavailable：没有可用的应答通道
 *
 * @typedef {"allowed-once" | "allowed-session" | "rejected" | "cancelled" | "unavailable"} ApprovalOutcome
 */
export const APPROVAL_OUTCOMES = /** @type {const} */ ([
  "allowed-once",
  "allowed-session",
  "rejected",
  "cancelled",
  "unavailable",
]);

/**
 * @typedef {object} ApprovalRequest
 * @property {string} toolName
 * @property {string} [callId]
 * @property {unknown} [arguments]
 * @property {string} [reason]
 *
 * @typedef {object} ApprovalsService
 * @property {(request: ApprovalRequest) => Promise<ApprovalOutcome>} request
 * @property {() => ApprovalPolicy} policy
 */

/**
 * 审批插件。使用前需要先 ctx.plugin(tools())，这样 pre-execute 才有人听。
 *
 * @param {object} [config]
 * @param {ApprovalPolicy} [config.policy] 默认 "ask"。传 "never" 则一律拒绝需要审批的调用。
 * @param {string[] | "all"} [config.tools] 需要询问的工具名，默认 shell / write / edit，以及 mcp__ 前缀的外部工具。传 "all" 表示全部都问。传入数组则完全按数组来。
 * @param {(request: ApprovalRequest) => ApprovalOutcome | Promise<ApprovalOutcome>} [config.prompt]
 *        应答函数。CLI 会传入终端提问，测试可以注入假的函数。
 * @returns {import("@hoshi/runtime").HoshiPlugin}
 */
export function approvals(config = {}) {
  const policy = normalizePolicy(config.policy);
  const askTools = normalizeAskTools(config.tools);
  const askMcpByDefault = config.tools === undefined;
  const prompt = config.prompt;

  return (ctx) => {
    /** 本会话已经选择「总是允许」的工具名。 */
    const sessionAllow = new Set();

    ctx.provide(APPROVALS_SERVICE, {
      /**
       * 管线遇到 ask 时会调用这里，把一次询问收成明确结果。
       * @param {ApprovalRequest} request
       * @returns {Promise<ApprovalOutcome>}
       */
      request(request) {
        return requestApproval(ctx, { policy, sessionAllow }, request);
      },
      /**
       * @returns {ApprovalPolicy}
       */
      policy() {
        return policy;
      },
    });

    // 把 config.prompt 登记成事件处理器，这样别人也可以再挂一层应答。
    if (typeof prompt === "function") {
      ctx.on(APPROVAL_EVENT.REQUEST, (_current, request) => prompt(request));
    }

    ctx.on(TOOL_EVENT.PRE_EXECUTE, (decision) => {
      if (!isAllow(decision)) return decision;
      const name = decision.call && typeof decision.call.name === "string" ? decision.call.name : "";
      if (!name || !needsAsk(askTools, name, askMcpByDefault)) return decision;
      if (sessionAllow.has(name)) return decision;
      return {
        ...decision,
        kind: "ask",
        reason: typeof decision.reason === "string" && decision.reason
          ? decision.reason
          : `工具 ${name} 需要确认后才能执行`,
      };
    });
  };
}

export default approvals;

/**
 * 向上下文发出 approvals/request，或按策略直接给出结果。
 * @param {import("@hoshi/runtime").HoshiContext} ctx
 * @param {{ policy: ApprovalPolicy, sessionAllow: Set<string> }} state
 * @param {ApprovalRequest} request
 * @returns {Promise<ApprovalOutcome>}
 */
async function requestApproval(ctx, state, request) {
  const toolName = request && typeof request.toolName === "string" ? request.toolName : "";
  if (toolName && state.sessionAllow.has(toolName)) {
    return "allowed-once";
  }
  if (state.policy === "never") {
    return "rejected";
  }

  // 初始值是 unavailable：没有任何处理器时就 fail closed，不会偷偷放行。
  const raw = await ctx.waterfall(APPROVAL_EVENT.REQUEST, "unavailable", request);
  const outcome = normalizeOutcome(raw);
  if (outcome === "allowed-session" && toolName) {
    state.sessionAllow.add(toolName);
  }
  return outcome;
}

/**
 * 在终端里问一句 y / n / a。stdin 不是交互终端时返回 unavailable，避免把管道里的数据读走。
 * @param {NodeJS.ReadableStream | undefined} stdin
 * @param {{ write: (chunk: string) => unknown }} stderr
 * @returns {(request: ApprovalRequest) => Promise<ApprovalOutcome>}
 */
export function createTerminalPrompt(stdin, stderr) {
  return async function prompt(request) {
    if (!stdin || stdin.readableEnded || stdin.destroyed) return "unavailable";
    // isTTY 为 false 时一定是管道或文件；undefined 时仍尝试提问，方便测试注入假流。
    if (stdin.isTTY === false) return "unavailable";

    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({
      input: stdin,
      output: toWritable(stderr),
      terminal: Boolean(stdin.isTTY),
    });
    try {
      const answer = await rl.question(formatPrompt(request));
      return parsePromptAnswer(answer);
    } finally {
      rl.close();
    }
  };
}

/**
 * 把一次询问格式化成给用户看的几行字。
 * @param {ApprovalRequest} request
 * @returns {string}
 */
export function formatPrompt(request) {
  const name = request && request.toolName ? request.toolName : "(unknown)";
  const lines = [`需要批准工具 ${name}`, `参数: ${formatArguments(request && request.arguments)}`];
  if (request && typeof request.reason === "string" && request.reason) {
    lines.push(`原因: ${request.reason}`);
  }
  lines.push("批准吗？[y=一次 / n=拒绝 / a=本会话都允许] ");
  return `${lines.join("\n")}`;
}

/**
 * 解析用户在提示里输入的答案。不认识的输入按拒绝处理。
 * @param {string} [text]
 * @returns {ApprovalOutcome}
 */
export function parsePromptAnswer(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (value === "y" || value === "yes" || value === "是") return "allowed-once";
  if (value === "a" || value === "always" || value === "总是") return "allowed-session";
  return "rejected";
}

/**
 * @param {unknown} value
 * @returns {ApprovalPolicy}
 */
function normalizePolicy(value) {
  if (value === undefined) return "ask";
  if (value === "ask" || value === "never") return value;
  throw new Error(`不认识的审批策略: ${String(value)}`);
}

/**
 * @param {string[] | "all" | undefined} value
 * @returns {Set<string> | "all"}
 */
function normalizeAskTools(value) {
  if (value === undefined) return new Set(DEFAULT_ASK_TOOLS);
  if (value === "all") return "all";
  if (!Array.isArray(value)) {
    throw new Error("approvals({ tools }) 需要工具名数组，或传入 \"all\"");
  }
  return new Set(value);
}

/**
 * @param {Set<string> | "all"} askTools
 * @param {string} name
 */
function needsAsk(askTools, name, askMcpByDefault = false) {
  if (askTools === "all" || askTools.has(name)) return true;
  // 用户没改名单时，外部 MCP 工具默认也要先问；显式传入数组则完全听用户的。
  return Boolean(askMcpByDefault && name.startsWith("mcp__"));
}

/**
 * @param {unknown} decision
 */
function isAllow(decision) {
  return typeof decision === "object" && decision !== null && decision.kind === "allow";
}

/**
 * @param {unknown} value
 * @returns {ApprovalOutcome}
 */
function normalizeOutcome(value) {
  if (typeof value === "string" && APPROVAL_OUTCOMES.includes(/** @type {ApprovalOutcome} */ (value))) {
    return /** @type {ApprovalOutcome} */ (value);
  }
  return "unavailable";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatArguments(value) {
  if (value === undefined) return "{}";
  try {
    const text = JSON.stringify(value);
    return text.length > 800 ? `${text.slice(0, 800)}…` : text;
  } catch {
    return String(value);
  }
}

/**
 * readline 的 output 需要是带 on 的可写流。测试里常常只传入 { write }，这里补一层包装。
 * @param {{ write?: (chunk: string) => unknown } | NodeJS.WritableStream | undefined} output
 * @returns {import("node:stream").Writable}
 */
function toWritable(output) {
  if (output && typeof output.on === "function" && typeof output.write === "function") {
    return /** @type {import("node:stream").Writable} */ (output);
  }
  return new Writable({
    write(chunk, encoding, callback) {
      if (output && typeof output.write === "function") {
        const text = typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : String(chunk);
        output.write(text);
      }
      callback();
    },
  });
}
