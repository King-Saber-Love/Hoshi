/**
 * Hoshi 的插件运行时。
 *
 * 插件是一个函数，接收上下文和可选配置。
 * 它可以提供服务、注册处理器，并监听事件。
 * 所有注册都必须是可撤销的 effect，以便插件能干净地卸载。
 *
 * @typedef {object} HoshiContext
 * @property {(plugin: HoshiPlugin, config?: object) => void} plugin
 * @property {(name: string, service: unknown) => void} provide
 * @property {(name: string) => Promise<unknown>} inject
 * @property {(event: string, handler: Function) => () => void} on
 * @property {(event: string, ...args: unknown[]) => Promise<void>} emit
 * @property {(event: string, ...args: unknown[]) => Promise<unknown>} waterfall
 * @property {(setup: () => (void | (() => void))) => () => void} effect
 *
 * @callback HoshiPlugin
 * @param {HoshiContext} ctx
 * @param {object} [config]
 * @returns {void | Promise<void>}
 */

/**
 * 创建根插件上下文。
 * @returns {HoshiContext}
 */
export function createContext() {
  throw new Error("TODO: @hoshi/runtime createContext");
}
