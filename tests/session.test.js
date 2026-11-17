import test from "node:test";
import assert from "node:assert/strict";
import { createSessionLog, deriveHistory, SESSION_EVENT } from "../packages/session/src/index.js";

test("append 会补齐 id 和 timestamp，并按顺序保存", () => {
  let now = 1000;
  let n = 0;
  const log = createSessionLog({
    clock: () => now,
    id: () => `e${++n}`,
  });
  const first = log.append({ type: SESSION_EVENT.TURN_START });
  now = 2000;
  const second = log.append({ type: SESSION_EVENT.MESSAGE, payload: { role: "user", content: "你好" } });

  assert.equal(first.id, "e1");
  assert.equal(first.timestamp, 1000);
  assert.equal(second.id, "e2");
  assert.equal(second.timestamp, 2000);
  assert.deepEqual(log.events().map((event) => event.id), ["e1", "e2"]);
});

test("传入的 id 和 timestamp 会被保留", () => {
  const log = createSessionLog();
  const stored = log.append({
    type: SESSION_EVENT.TURN_END,
    id: "turn-1-end",
    timestamp: 42,
  });
  assert.equal(stored.id, "turn-1-end");
  assert.equal(stored.timestamp, 42);
});

test("events() 返回副本，改它不会改到日志", () => {
  const log = createSessionLog();
  log.append({ type: SESSION_EVENT.TURN_START, id: "t1" });
  const copy = log.events();
  copy.pop();
  assert.equal(log.events().length, 1);
});

test("已经写入的事件不能再被修改", () => {
  const log = createSessionLog();
  const stored = log.append({
    type: SESSION_EVENT.MESSAGE,
    payload: { role: "user", content: "你好" },
  });
  assert.throws(() => {
    stored.type = "hacked";
  }, TypeError);
  assert.throws(() => {
    stored.payload.content = "被改了";
  }, TypeError);
  assert.equal(log.events()[0].payload.content, "你好");
});

test("没有 type 的事件不能追加", () => {
  const log = createSessionLog();
  assert.throws(() => log.append({}), /type/);
});

test("空日志派生出空历史", () => {
  const log = createSessionLog();
  assert.deepEqual(deriveHistory(log), []);
  assert.deepEqual(log.history(), []);
});

test("用户和助手的 message 会按顺序变成历史", () => {
  const log = createSessionLog();
  log.append({ type: SESSION_EVENT.TURN_START, id: "turn-1" });
  log.append({ type: SESSION_EVENT.MESSAGE, payload: { role: "user", content: "1+1 等于几" } });
  log.append({ type: SESSION_EVENT.STEP_START, id: "step-1" });
  log.append({ type: SESSION_EVENT.MESSAGE, payload: { role: "assistant", content: "等于 2" } });
  log.append({ type: SESSION_EVENT.STEP_END, id: "step-1" });
  log.append({ type: SESSION_EVENT.TURN_END, id: "turn-1" });

  assert.deepEqual(log.history(), [
    { role: "user", content: "1+1 等于几" },
    { role: "assistant", content: "等于 2" },
  ]);
});

test("log.history() 和 deriveHistory(log) 结果相同", () => {
  const log = createSessionLog();
  log.append({ type: SESSION_EVENT.MESSAGE, payload: { role: "system", content: "你是助手" } });
  log.append({ type: SESSION_EVENT.MESSAGE, payload: { role: "user", content: "嗨" } });
  assert.deepEqual(log.history(), deriveHistory(log));
});

test("工具调用会挂到助手消息上，结果变成 tool 消息", () => {
  const log = createSessionLog();
  log.append({ type: SESSION_EVENT.MESSAGE, payload: { role: "user", content: "现在几点" } });
  log.append({ type: SESSION_EVENT.MESSAGE, payload: { role: "assistant", content: "我去看一下" } });
  log.append({
    type: SESSION_EVENT.TOOL_CALL,
    payload: { id: "call-1", name: "clock", arguments: { zone: "Asia/Shanghai" } },
  });
  log.append({
    type: SESSION_EVENT.TOOL_RESULT,
    payload: { callId: "call-1", name: "clock", result: "16:21" },
  });
  log.append({ type: SESSION_EVENT.MESSAGE, payload: { role: "assistant", content: "现在是 16:21" } });

  assert.deepEqual(log.history(), [
    { role: "user", content: "现在几点" },
    {
      role: "assistant",
      content: "我去看一下",
      toolCalls: [{ id: "call-1", name: "clock", arguments: { zone: "Asia/Shanghai" } }],
    },
    { role: "tool", content: "16:21", name: "clock", toolCallId: "call-1" },
    { role: "assistant", content: "现在是 16:21" },
  ]);
});

test("只有 tool/call 没有助手文本时，会补一条空内容的 assistant 消息", () => {
  const log = createSessionLog();
  log.append({ type: SESSION_EVENT.MESSAGE, payload: { role: "user", content: "列一下目录" } });
  log.append({
    type: SESSION_EVENT.TOOL_CALL,
    payload: { id: "call-2", name: "ls", arguments: {} },
  });
  const history = log.history();
  assert.equal(history.length, 2);
  assert.deepEqual(history[1].toolCalls, [{ id: "call-2", name: "ls", arguments: {} }]);
  assert.equal(history[1].content, "");
});

test("工具出错时，历史里的 content 使用 error 文本", () => {
  const log = createSessionLog();
  log.append({
    type: SESSION_EVENT.TOOL_CALL,
    payload: { id: "call-3", name: "shell", arguments: { cmd: "nope" } },
  });
  log.append({
    type: SESSION_EVENT.TOOL_RESULT,
    payload: { callId: "call-3", name: "shell", error: "命令不存在" },
  });
  const toolMessage = log.history()[1];
  assert.equal(toolMessage.role, "tool");
  assert.equal(toolMessage.content, "命令不存在");
  assert.equal(toolMessage.toolCallId, "call-3");
});

test("可以用已有事件创建一份新日志，且不改动原来的数组", () => {
  const seed = [{ type: SESSION_EVENT.MESSAGE, id: "m1", timestamp: 1, payload: { role: "user", content: "hi" } }];
  const log = createSessionLog({ events: seed });
  log.append({ type: SESSION_EVENT.MESSAGE, payload: { role: "assistant", content: "hello" } });
  assert.equal(seed.length, 1);
  assert.equal(log.events().length, 2);
  assert.deepEqual(log.history(), [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
});

test("两份日志互不干扰", () => {
  const a = createSessionLog();
  const b = createSessionLog();
  a.append({ type: SESSION_EVENT.MESSAGE, payload: { role: "user", content: "A" } });
  b.append({ type: SESSION_EVENT.MESSAGE, payload: { role: "user", content: "B" } });
  assert.deepEqual(a.history(), [{ role: "user", content: "A" }]);
  assert.deepEqual(b.history(), [{ role: "user", content: "B" }]);
});

test("deriveHistory 在传入的不是日志时会抛错", () => {
  assert.throws(() => deriveHistory({}), /会话日志/);
});
