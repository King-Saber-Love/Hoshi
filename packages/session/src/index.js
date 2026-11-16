/**
 * 只追加的事件源会话日志。
 * 事件是唯一事实来源；历史始终由日志派生，从不原地修改。
 *
 * turn/*、step/*、tool/call 这类官方风格的事件类型，
 * 属于这里的持久化日志事件，而不是运行时（Cordis 风格）的总线事件。
 *
 * @typedef {object} SessionEvent
 * @property {string} type
 * @property {string} [id]
 * @property {number} [timestamp]
 * @property {unknown} [payload]
 *
 * @typedef {object} SessionLog
 * @property {() => SessionEvent[]} events
 * @property {(event: SessionEvent) => void} append
 * @property {() => object[]} history
 */

/**
 * 创建一份内存中的会话日志。持久化适配器可以稍后包在这层外面。
 * @param {object} [options]
 * @returns {SessionLog}
 */
export function createSessionLog(options) {
  throw new Error("TODO: @hoshi/session createSessionLog");
}

/**
 * 从只追加的事件日志派生出对话历史。
 * @param {SessionLog} log
 * @returns {object[]}
 */
export function deriveHistory(log) {
  throw new Error("TODO: @hoshi/session deriveHistory");
}
