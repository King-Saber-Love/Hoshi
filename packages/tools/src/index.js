/**
 * 工具管线：把可调用的工具登记到上下文上，每次调用依次经过
 * tools/pre-execute、真正执行、tools/post-execute。
 *
 * 这是一个插件。先 ctx.plugin(tools()) 挂上服务，再用 registerTool 登记工具。
 * 核心循环通过 ctx.get("tools") 拿到 { list, run }：list 提供给模型看的 schema，
 * run 执行一次调用。审批（ask）以后由 approvals 插件在 pre-execute 里接入。
 */

/** 挂到上下文上的服务名，与 @hoshi/core 的 TOOLS_SERVICE 相同。 */
export const TOOLS_SERVICE = "tools";

/** 管线三个阶段对应的事件名，都走已有的 on / emit / waterfall。 */
export const TOOL_EVENT = {
  PRE_EXECUTE: "tools/pre-execute",
  EXECUTE: "tools/execute",
  POST_EXECUTE: "tools/post-execute",
};

/**
 * @typedef {object} ToolDefinition
 * @property {string} name
 * @property {string} [description]
 * @property {object} [schema]  JSON Schema，发给模型的参数说明
 * @property {(args: object, ctx: object) => unknown | Promise<unknown>} execute
 *
 * @typedef {object} ToolCall
 * @property {string} name
 * @property {string} [id]
 * @property {unknown} [arguments]
 * @property {unknown} [args]  arguments 的别名，兼容较早的调用形状
 *
 * @typedef {object} PreToolDecision
 * @property {"allow" | "deny"} kind
 * @property {string} [reason]  kind 为 deny 时的原因
 * @property {unknown} [arguments]  允许时可以改写后交给工具的参数
 * @property {ToolCall} [call]
 *
 * @typedef {object} PostToolDecision
 * @property {"allow" | "deny"} kind
 * @property {string} [reason]
 * @property {unknown} [result]  允许时可以改写工具的返回值
 * @property {ToolCall} [call]
 */

/**
 * 工具管线插件。挂载后会 provide("tools", { list, run })。
 * 也可以通过 config.tools 在挂载时一并登记若干工具。
 * @param {object} [config]
 * @param {ToolDefinition[]} [config.tools]
 * @returns {import("@hoshi/runtime").HoshiPlugin}
 */
export function tools(config = {}) {
  return (ctx) => {
    const registry = new Map();

    ctx.provide(TOOLS_SERVICE, {
      /**
       * 返回给模型看的工具列表，不含 execute 函数。
       * @returns {Array<{ name: string, description?: string, schema: object }>}
       */
      list() {
        return [...registry.values()].map((tool) => toPublicTool(tool));
      },
      /**
       * 跑完一次调用的整条管线。
       * @param {ToolCall} call
       */
      run(call) {
        return runRegisteredTool(ctx, registry, call);
      },
      /**
       * 供 registerTool 使用的登记表操作。
       * @param {ToolDefinition} tool
       */
      register(tool) {
        registry.set(tool.name, tool);
      },
      /**
       * @param {string} name
       * @param {ToolDefinition} [tool]  只删除仍是这一份定义的登记，避免误删后来者
       */
      unregister(name, tool) {
        if (tool && registry.get(name) !== tool) return;
        registry.delete(name);
      },
    });

    for (const tool of config.tools ?? []) {
      registerTool(ctx, tool);
    }
  };
}

export default tools;

/**
 * 在上下文上登记一个工具。必须先挂上 tools 插件。
 * 用 effect 登记，所以当前插件卸载时会自动撤销。
 * @param {import("@hoshi/runtime").HoshiContext} ctx
 * @param {ToolDefinition} tool
 * @returns {() => void} 手动撤销登记的函数
 */
export function registerTool(ctx, tool) {
  const service = requireService(ctx);
  const definition = normalizeDefinition(tool);
  if (serviceHas(service, definition.name)) {
    throw new Error(`工具 ${definition.name} 已经登记过了`);
  }

  return ctx.effect(() => {
    service.register(definition);
    return () => service.unregister(definition.name, definition);
  });
}

/**
 * 让一次工具调用走完 pre-execute、execute、post-execute。
 * @param {import("@hoshi/runtime").HoshiContext} ctx
 * @param {ToolCall} call
 * @returns {Promise<unknown>}
 */
export function runTool(ctx, call) {
  const service = requireService(ctx);
  return service.run(call);
}

/**
 * @param {import("@hoshi/runtime").HoshiContext} ctx
 * @param {Map<string, ToolDefinition>} registry
 * @param {ToolCall} call
 * @returns {Promise<unknown>}
 */
async function runRegisteredTool(ctx, registry, call) {
  if (!call || typeof call.name !== "string" || call.name.length === 0) {
    throw new Error("工具调用需要 name");
  }

  const tool = registry.get(call.name);
  if (!tool) {
    throw new Error(`未注册的工具: ${call.name}`);
  }

  const originalArgs = call.arguments !== undefined ? call.arguments : call.args;
  const args = originalArgs === undefined ? {} : originalArgs;

  const pre = await ctx.waterfall(TOOL_EVENT.PRE_EXECUTE, {
    kind: "allow",
    call,
    arguments: args,
  });

  if (isDeny(pre)) {
    throw new Error(denyReason(pre, call.name));
  }

  const finalArgs = decisionArguments(pre, args);
  const exec = { id: call.id, name: call.name, arguments: finalArgs, tool };

  // 这一步只通知观察者，真正执行还是调用工具自己的 execute。
  await ctx.emit(TOOL_EVENT.EXECUTE, exec);
  const rawResult = await tool.execute(finalArgs, ctx);

  const post = await ctx.waterfall(TOOL_EVENT.POST_EXECUTE, {
    kind: "allow",
    call: exec,
    result: rawResult,
  });

  if (isDeny(post)) {
    throw new Error(denyReason(post, call.name));
  }

  if (isDecision(post) && "result" in post) {
    return post.result;
  }
  return rawResult;
}

/**
 * @param {import("@hoshi/runtime").HoshiContext} ctx
 */
function requireService(ctx) {
  if (!ctx || typeof ctx.get !== "function") {
    throw new Error("registerTool / runTool 需要一个插件上下文");
  }
  const service = ctx.get(TOOLS_SERVICE);
  if (!service || typeof service.run !== "function" || typeof service.list !== "function") {
    throw new Error("请先 ctx.plugin(tools()) 挂上工具管线");
  }
  return service;
}

/**
 * @param {object} service
 * @param {string} name
 */
function serviceHas(service, name) {
  const listed = service.list();
  return Array.isArray(listed) && listed.some((item) => item && item.name === name);
}

/**
 * @param {ToolDefinition} tool
 * @returns {ToolDefinition}
 */
function normalizeDefinition(tool) {
  if (!tool || typeof tool !== "object") {
    throw new Error("registerTool 需要一个工具定义");
  }
  if (typeof tool.name !== "string" || tool.name.length === 0) {
    throw new Error("工具定义需要非空的 name");
  }
  if (typeof tool.execute !== "function") {
    throw new Error(`工具 ${tool.name} 需要 execute 函数`);
  }
  return tool;
}

/**
 * @param {ToolDefinition} tool
 */
function toPublicTool(tool) {
  /** @type {{ name: string, description?: string, schema: object }} */
  const item = {
    name: tool.name,
    schema: tool.schema ?? { type: "object", properties: {} },
  };
  if (typeof tool.description === "string") {
    item.description = tool.description;
  }
  return item;
}

/**
 * @param {unknown} decision
 */
function isDecision(decision) {
  return typeof decision === "object" && decision !== null;
}

/**
 * @param {unknown} decision
 */
function isDeny(decision) {
  return isDecision(decision) && decision.kind === "deny";
}

/**
 * @param {unknown} decision
 * @param {string} name
 */
function denyReason(decision, name) {
  if (isDecision(decision) && typeof decision.reason === "string" && decision.reason.length > 0) {
    return decision.reason;
  }
  return `工具 ${name} 被拒绝`;
}

/**
 * @param {unknown} decision
 * @param {unknown} fallback
 */
function decisionArguments(decision, fallback) {
  if (isDecision(decision) && "arguments" in decision) {
    return decision.arguments;
  }
  return fallback;
}
