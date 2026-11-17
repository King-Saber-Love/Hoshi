/**
 * Agent 核心：turn / step 循环，以及系统提示词和工具 schema 的组装。
 *
 * 循环在进程内运行，不绑定某一家模型或某一种壳。
 * 模型通过上下文里的 "llm" 服务调用（llm.stream）；
 * 工具通过可选的 "tools" 服务调用（list / run）。
 * 过程中发生的事实只写入会话日志；要看对话，用 log.history()。
 */

import { createSessionLog, SESSION_EVENT } from "@hoshi/session";
import { LLM_SERVICE } from "@hoshi/llm";

/** 工具管线挂到上下文上时使用的服务名，与 "llm" 同一套 provide / inject 约定。 */
export const TOOLS_SERVICE = "tools";

/** 一轮里最多走多少个模型步骤，避免工具来回调用时死循环。 */
const DEFAULT_MAX_STEPS = 16;

/**
 * @typedef {object} HoshiAgent
 * @property {object} ctx
 * @property {import("@hoshi/session").SessionLog} session
 * @property {(input: string) => Promise<void>} runTurn
 */

/**
 * 基于插件上下文和会话日志创建一个 Agent。
 * 若没有传入 options.session，会在内存里新建一份日志。
 * 调用 runTurn 之前，需要已经有插件 provide("llm", 适配器)。
 * @param {import("@hoshi/runtime").HoshiContext} ctx
 * @param {object} [options]
 * @param {import("@hoshi/session").SessionLog} [options.session]
 * @param {string} [options.system] 系统提示词的初始值，可被 assemble-prompt 事件继续加工
 * @param {number} [options.maxSteps]
 * @param {object} [options.llm] 直接传入模型服务，测试时可以不走 inject
 * @param {object} [options.tools] 直接传入工具服务，测试时可以不走 inject
 * @returns {HoshiAgent}
 */
export function createAgent(ctx, options = {}) {
  if (!ctx || typeof ctx.inject !== "function" || typeof ctx.emit !== "function") {
    throw new Error("createAgent 需要一个插件上下文");
  }

  const session = options.session ?? createSessionLog();
  const agent = {
    ctx,
    session,
    /** @private */
    options,
    /**
     * 跑完一轮用户输入。和导出的 runTurn(agent, input) 是同一条路径。
     * @param {string} input
     * @returns {Promise<void>}
     */
    runTurn(input) {
      return runTurn(agent, input);
    },
  };
  return agent;
}

/**
 * 跑完一轮用户 turn，包括其间的工具步骤。
 * 成功、失败或步数用尽，都会在日志里留下 turn/end。
 * @param {HoshiAgent} agent
 * @param {string} input
 * @returns {Promise<void>}
 */
export async function runTurn(agent, input) {
  if (!agent || !agent.session || !agent.ctx) {
    throw new Error("runTurn 需要一个由 createAgent 创建的 Agent");
  }
  if (typeof input !== "string") {
    throw new Error("runTurn 的输入必须是字符串");
  }

  const { ctx, session, options } = agent;
  const maxSteps = Number.isInteger(options.maxSteps) && options.maxSteps > 0
    ? options.maxSteps
    : DEFAULT_MAX_STEPS;

  const turnId = crypto.randomUUID();
  session.append({
    type: SESSION_EVENT.TURN_START,
    id: turnId,
    payload: { input },
  });
  session.append({
    type: SESSION_EVENT.MESSAGE,
    payload: { role: "user", content: input, turnId },
  });
  await ctx.emit("turn-start", { turnId, input });

  let status = "completed";
  /** @type {string | undefined} */
  let errorMessage;

  try {
    const llm = await resolveLlm(ctx, options);
    const tools = await resolveTools(ctx, options);

    for (let step = 1; step <= maxSteps; step += 1) {
      const stepId = crypto.randomUUID();
      session.append({
        type: SESSION_EVENT.STEP_START,
        id: stepId,
        payload: { turnId, kind: "llm", index: step },
      });
      await ctx.emit("step-start", { turnId, stepId, kind: "llm", index: step });

      const history = session.history();
      const systemPrompt = await assemblePrompt(ctx, options, agent, history);
      const toolDefs = await assembleTools(ctx, tools, agent);
      const messages = buildRequestMessages(systemPrompt, history);

      const { text, toolCalls } = await collectStream(
        llm.stream({ messages, tools: toolDefs, options: options.llmOptions }),
      );

      if (text) {
        session.append({
          type: SESSION_EVENT.MESSAGE,
          payload: { role: "assistant", content: text, turnId, stepId },
        });
      }
      for (const call of toolCalls) {
        session.append({
          type: SESSION_EVENT.TOOL_CALL,
          payload: {
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            turnId,
            stepId,
          },
        });
      }

      session.append({
        type: SESSION_EVENT.STEP_END,
        id: `${stepId}-end`,
        payload: { turnId, stepId, kind: "llm" },
      });
      await ctx.emit("step-end", { turnId, stepId, kind: "llm" });

      if (toolCalls.length === 0) {
        return;
      }

      if (step === maxSteps) {
        status = "aborted";
        return;
      }

      const toolStepId = crypto.randomUUID();
      session.append({
        type: SESSION_EVENT.STEP_START,
        id: toolStepId,
        payload: { turnId, kind: "tool", index: step },
      });
      await ctx.emit("step-start", { turnId, stepId: toolStepId, kind: "tool", index: step });

      for (const call of toolCalls) {
        await runOneTool(tools, session, call, turnId, toolStepId);
      }

      session.append({
        type: SESSION_EVENT.STEP_END,
        id: `${toolStepId}-end`,
        payload: { turnId, stepId: toolStepId, kind: "tool" },
      });
      await ctx.emit("step-end", { turnId, stepId: toolStepId, kind: "tool" });
    }
  } catch (error) {
    status = "error";
    errorMessage = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    session.append({
      type: SESSION_EVENT.TURN_END,
      id: `${turnId}-end`,
      payload: { turnId, status, error: errorMessage },
    });
    await ctx.emit("turn-end", { turnId, status, error: errorMessage });
  }
}

/**
 * 取出模型服务：优先用 options.llm，否则 inject("llm")。
 * @param {object} ctx
 * @param {object} options
 */
async function resolveLlm(ctx, options) {
  const llm = options.llm ?? (await ctx.inject(LLM_SERVICE));
  if (!llm || typeof llm.stream !== "function") {
    throw new Error("未找到可用的 llm.stream，请先挂上模型适配器插件");
  }
  return llm;
}

/**
 * 取出工具服务：可没有。没有的话，模型一旦要求调工具，会在日志里记下错误结果。
 * @param {object} ctx
 * @param {object} options
 */
async function resolveTools(ctx, options) {
  if (options.tools) return options.tools;
  if (typeof ctx.get === "function") {
    return ctx.get(TOOLS_SERVICE) ?? null;
  }
  return null;
}

/**
 * 系统提示词：从 options.system 出发，经过 assemble-prompt 瀑布流加工。
 * @param {object} ctx
 * @param {object} options
 * @param {HoshiAgent} agent
 * @param {object[]} history
 * @returns {Promise<string>}
 */
async function assemblePrompt(ctx, options, agent, history) {
  const base = typeof options.system === "string" ? options.system : "";
  const assembled = await ctx.waterfall("assemble-prompt", base, { agent, history });
  return typeof assembled === "string" ? assembled : base;
}

/**
 * 工具列表：先问工具服务的 list，再经过 assemble-tools 瀑布流加工。
 * @param {object} ctx
 * @param {object | null} tools
 * @param {HoshiAgent} agent
 * @returns {Promise<object[]>}
 */
async function assembleTools(ctx, tools, agent) {
  const base = tools && typeof tools.list === "function" ? await tools.list() : [];
  const assembled = await ctx.waterfall("assemble-tools", Array.isArray(base) ? base : [], { agent });
  return Array.isArray(assembled) ? assembled : [];
}

/**
 * 发给模型的消息：组装好的系统提示放在最前，后面跟日志派生的历史。
 * @param {string} systemPrompt
 * @param {object[]} history
 * @returns {object[]}
 */
function buildRequestMessages(systemPrompt, history) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }
  for (const message of history) {
    messages.push(message);
  }
  return messages;
}

/**
 * 把模型流里的文本和工具调用收齐。
 * 支持同步或异步的可迭代对象；chunk.type 为 "text" 或 "tool_call"。
 * @param {AsyncIterable<object> | Iterable<object> | Promise<AsyncIterable<object> | Iterable<object>>} stream
 * @returns {Promise<{ text: string, toolCalls: Array<{ id: string, name: string, arguments: unknown }> }>}
 */
async function collectStream(stream) {
  const iterable = await stream;
  let text = "";
  /** @type {Array<{ id: string, name: string, arguments: unknown }>} */
  const toolCalls = [];

  for await (const chunk of iterable) {
    if (!chunk || typeof chunk !== "object") continue;
    if (chunk.type === "text" && typeof chunk.text === "string") {
      text += chunk.text;
    } else if (chunk.type === "tool_call" && chunk.toolCall && typeof chunk.toolCall === "object") {
      const call = chunk.toolCall;
      toolCalls.push({
        id: typeof call.id === "string" && call.id.length > 0 ? call.id : crypto.randomUUID(),
        name: typeof call.name === "string" ? call.name : "",
        arguments: call.arguments,
      });
    }
  }

  return { text, toolCalls };
}

/**
 * 执行一次工具调用，并把结果或错误追加到日志。工具抛错不会中断这一轮。
 * @param {object | null} tools
 * @param {import("@hoshi/session").SessionLog} session
 * @param {{ id: string, name: string, arguments: unknown }} call
 * @param {string} turnId
 * @param {string} stepId
 */
async function runOneTool(tools, session, call, turnId, stepId) {
  if (!tools || typeof tools.run !== "function") {
    session.append({
      type: SESSION_EVENT.TOOL_RESULT,
      payload: {
        callId: call.id,
        name: call.name,
        error: "未挂载工具服务，无法执行该调用",
        turnId,
        stepId,
      },
    });
    return;
  }

  try {
    const result = await tools.run({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
    session.append({
      type: SESSION_EVENT.TOOL_RESULT,
      payload: { callId: call.id, name: call.name, result, turnId, stepId },
    });
  } catch (error) {
    session.append({
      type: SESSION_EVENT.TOOL_RESULT,
      payload: {
        callId: call.id,
        name: call.name,
        error: error instanceof Error ? error.message : String(error),
        turnId,
        stepId,
      },
    });
  }
}
