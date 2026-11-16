/**
 * 工具管线：每次工具调用都会经过 pre-execute、execute、post-execute。
 *
 * @typedef {object} ToolDefinition
 * @property {string} name
 * @property {string} [description]
 * @property {object} [schema]
 * @property {(args: object, ctx: object) => unknown | Promise<unknown>} execute
 */

/**
 * 在上下文上注册一个工具。
 * @param {import("@hoshi/runtime").HoshiContext} ctx
 * @param {ToolDefinition} tool
 */
export function registerTool(ctx, tool) {
  throw new Error("TODO: @hoshi/tools registerTool");
}

/**
 * 让一次工具调用依次经过 pre-execute、execute、post-execute。
 * @param {import("@hoshi/runtime").HoshiContext} ctx
 * @param {{ name: string, args: object }} call
 * @returns {Promise<unknown>}
 */
export function runTool(ctx, call) {
  throw new Error("TODO: @hoshi/tools runTool");
}
