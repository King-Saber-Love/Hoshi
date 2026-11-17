/**
 * 只追加的事件源会话日志。
 *
 * 事件是唯一事实来源：已经写下的记录不能改、不能删，只能再追加。
 * 对话历史不是另存的一份数据，而是每次用 deriveHistory 从日志算出来的视图。
 *
 * 这里的事件（turn/*、step/*、tool/call 等）是持久化的会话记录，
 * 不是 @hoshi/runtime 里 ctx.emit 那种运行时总线事件，两者不要混用。
 *
 * 约定两类事件：
 * - 结构事件：turn/start、turn/end、step/start、step/end，用来框定「第几轮、第几步」
 * - 内容事件：message、tool/call、tool/result，用来派生给模型看的历史
 */

export const SESSION_EVENT = {
  TURN_START: "turn/start",
  TURN_END: "turn/end",
  STEP_START: "step/start",
  STEP_END: "step/end",
  MESSAGE: "message",
  TOOL_CALL: "tool/call",
  TOOL_RESULT: "tool/result",
};

/**
 * @typedef {object} SessionEvent
 * @property {string} type
 * @property {string} id
 * @property {number} timestamp
 * @property {unknown} [payload]
 *
 * @typedef {object} HistoryMessage
 * @property {"user" | "assistant" | "system" | "tool"} role
 * @property {string} content
 * @property {string} [name]
 * @property {string} [toolCallId]
 * @property {Array<{ id: string, name: string, arguments: unknown }>} [toolCalls]
 *
 * @typedef {object} SessionLog
 * @property {() => SessionEvent[]} events
 * @property {(event: { type: string, id?: string, timestamp?: number, payload?: unknown }) => SessionEvent} append
 * @property {() => HistoryMessage[]} history
 *
 * @typedef {object} CreateSessionLogOptions
 * @property {SessionEvent[]} [events] 初始事件，会被复制进新日志，不修改原数组
 * @property {() => number} [clock] 自定义时间戳，默认 Date.now，方便测试
 * @property {() => string} [id] 自定义 id，默认 crypto.randomUUID，方便测试
 */

/**
 * 把调用方传入的事件整理成日志里真正保存的形态。
 * 缺 id 或 timestamp 就补上；payload 会复制一份，避免事后改原对象影响到日志。
 * 整条记录（包括 payload）都会被冻结，事后改字段不会生效。
 * @param {object} event
 * @param {() => number} now
 * @param {() => string} nextId
 * @returns {SessionEvent}
 */
function normalizeEvent(event, now, nextId) {
  if (!event || typeof event !== "object") {
    throw new Error("append 需要一个事件对象");
  }
  if (typeof event.type !== "string" || event.type.length === 0) {
    throw new Error("事件必须有非空的 type");
  }
  const stored = {
    type: event.type,
    id: typeof event.id === "string" && event.id.length > 0 ? event.id : nextId(),
    timestamp: typeof event.timestamp === "number" ? event.timestamp : now(),
    payload: event.payload === undefined ? undefined : structuredClone(event.payload),
  };
  return deepFreeze(stored);
}

/**
 * 递归冻结对象，避免只冻住外层、payload 里的字段仍能被改。
 * @param {unknown} value
 * @returns {unknown}
 */
function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * 把工具结果变成历史里的文本。字符串原样用，其他值做成 JSON，方便模型阅读。
 * @param {unknown} value
 * @returns {string}
 */
function toContent(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

/**
 * 创建一份内存中的会话日志。持久化（写文件、写数据库）可以以后再包在这层外面。
 * @param {CreateSessionLogOptions} [options]
 * @returns {SessionLog}
 */
export function createSessionLog(options = {}) {
  const now = options.clock ?? Date.now;
  const nextId = options.id ?? (() => crypto.randomUUID());
  /** @type {SessionEvent[]} */
  const events = [];

  const log = {
    /**
     * 返回到目前为止的全部事件。给的是数组副本，改这个数组不会改到日志本身。
     * @returns {SessionEvent[]}
     */
    events() {
      return events.slice();
    },

    /**
     * 追加一条事件，并返回日志里实际保存的那条（已补齐 id、timestamp，且被冻结）。
     * @param {{ type: string, id?: string, timestamp?: number, payload?: unknown }} event
     * @returns {SessionEvent}
     */
    append(event) {
      const stored = normalizeEvent(event, now, nextId);
      events.push(stored);
      return stored;
    },

    /**
     * 从当前日志派生对话历史，等价于 deriveHistory(log)。
     * @returns {HistoryMessage[]}
     */
    history() {
      return deriveHistory(log);
    },
  };

  if (Array.isArray(options.events)) {
    for (const event of options.events) {
      log.append(event);
    }
  }

  return log;
}

/**
 * 从只追加的事件日志，算出模型（以及界面）要看的对话历史。
 * 只读取内容事件；turn/start、step/end 这类结构事件不会变成消息。
 *
 * 规则很短：
 * - message：按 payload.role 追加一条消息
 * - tool/call：挂到最近一条 assistant 消息的 toolCalls 上；若还没有，就先补一条空内容的 assistant
 * - tool/result：追加一条 role 为 tool 的消息，content 是结果文本
 * @param {SessionLog} log
 * @returns {HistoryMessage[]}
 */
export function deriveHistory(log) {
  if (!log || typeof log.events !== "function") {
    throw new Error("deriveHistory 需要一份会话日志");
  }

  /** @type {HistoryMessage[]} */
  const messages = [];
  /** @type {HistoryMessage | null} */
  let openAssistant = null;

  /**
   * 即将追加一条非 assistant 消息时，先收尾：空的 toolCalls 不要留在历史上。
   */
  function closeAssistant() {
    if (openAssistant && Array.isArray(openAssistant.toolCalls) && openAssistant.toolCalls.length === 0) {
      delete openAssistant.toolCalls;
    }
    openAssistant = null;
  }

  for (const event of log.events()) {
    if (event.type === SESSION_EVENT.MESSAGE) {
      const payload = event.payload ?? {};
      const role = payload.role;
      if (typeof role !== "string" || role.length === 0) {
        continue;
      }
      if (role === "assistant") {
        closeAssistant();
        openAssistant = {
          role: "assistant",
          content: toContent(payload.content),
        };
        messages.push(openAssistant);
        continue;
      }
      closeAssistant();
      /** @type {HistoryMessage} */
      const message = {
        role,
        content: toContent(payload.content),
      };
      if (typeof payload.name === "string") message.name = payload.name;
      if (typeof payload.toolCallId === "string") message.toolCallId = payload.toolCallId;
      messages.push(message);
      continue;
    }

    if (event.type === SESSION_EVENT.TOOL_CALL) {
      const payload = event.payload ?? {};
      if (!openAssistant || openAssistant.role !== "assistant") {
        openAssistant = { role: "assistant", content: "" };
        messages.push(openAssistant);
      }
      if (!openAssistant.toolCalls) openAssistant.toolCalls = [];
      openAssistant.toolCalls.push({
        id: typeof payload.id === "string" ? payload.id : event.id,
        name: typeof payload.name === "string" ? payload.name : "",
        arguments: payload.arguments,
      });
      continue;
    }

    if (event.type === SESSION_EVENT.TOOL_RESULT) {
      const payload = event.payload ?? {};
      closeAssistant();
      /** @type {HistoryMessage} */
      const message = {
        role: "tool",
        content: payload.error ? toContent(payload.error) : toContent(payload.result),
      };
      if (typeof payload.name === "string") message.name = payload.name;
      if (typeof payload.callId === "string") message.toolCallId = payload.callId;
      messages.push(message);
    }
  }

  closeAssistant();
  return messages;
}
