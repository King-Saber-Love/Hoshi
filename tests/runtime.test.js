import test from "node:test";
import assert from "node:assert/strict";
import { createContext } from "../packages/runtime/src/index.js";

test("provide 之后 inject 能拿到同一份服务", async () => {
  const ctx = createContext();
  const llm = { name: "deepseek" };
  ctx.provide("llm", llm);
  assert.equal(await ctx.inject("llm"), llm);
});

test("inject 会等待尚未提供的服务", async () => {
  const ctx = createContext();
  const pending = ctx.inject("llm");
  const llm = { name: "openai" };
  ctx.provide("llm", llm);
  assert.equal(await pending, llm);
});

test("重复 provide 同一服务名会抛错", () => {
  const ctx = createContext();
  ctx.provide("llm", {});
  assert.throws(() => ctx.provide("llm", {}), /已经注册/);
});

test("两个上下文的服务互不干扰", async () => {
  const a = createContext();
  const b = createContext();
  a.provide("llm", "A");
  b.provide("llm", "B");
  assert.equal(await a.inject("llm"), "A");
  assert.equal(await b.inject("llm"), "B");
});

test("on 加上 emit 会并行调用所有处理器", async () => {
  const ctx = createContext();
  const seen = [];
  ctx.on("turn-start", (value) => {
    seen.push(`a:${value}`);
  });
  ctx.on("turn-start", async (value) => {
    seen.push(`b:${value}`);
  });
  await ctx.emit("turn-start", 1);
  assert.deepEqual(seen.sort(), ["a:1", "b:1"]);
});

test("emit 会等所有处理器跑完，再抛出其中的错误", async () => {
  const ctx = createContext();
  let secondRan = false;
  ctx.on("step", () => {
    throw new Error("第一个失败");
  });
  ctx.on("step", () => {
    secondRan = true;
  });
  await assert.rejects(() => ctx.emit("step"), /第一个失败/);
  assert.equal(secondRan, true);
});

test("取消订阅后 emit 不再调用该处理器", async () => {
  const ctx = createContext();
  let count = 0;
  const off = ctx.on("tick", () => {
    count += 1;
  });
  await ctx.emit("tick");
  off();
  await ctx.emit("tick");
  assert.equal(count, 1);
});

test("waterfall 按注册顺序传递并变换值", async () => {
  const ctx = createContext();
  ctx.on("assemble-prompt", (text) => `${text}[规则]`);
  ctx.on("assemble-prompt", async (text) => `${text}[工具]`);
  const result = await ctx.waterfall("assemble-prompt", "系统：");
  assert.equal(result, "系统：[规则][工具]");
});

test("waterfall 在没有处理器时原样返回初始值", async () => {
  const ctx = createContext();
  assert.equal(await ctx.waterfall("assemble-prompt", "空"), "空");
});

test("effect 的清理函数在手动撤销时执行", () => {
  const ctx = createContext();
  let cleaned = false;
  const dispose = ctx.effect(() => () => {
    cleaned = true;
  });
  assert.equal(cleaned, false);
  dispose();
  dispose();
  assert.equal(cleaned, true);
});

test("卸载插件会撤销它登记的服务、监听和 effect", async () => {
  const ctx = createContext();
  let cleaned = false;
  let heard = 0;

  const uninstall = ctx.plugin((ctx) => {
    ctx.provide("shell", { run() {} });
    ctx.on("tick", () => {
      heard += 1;
    });
    ctx.effect(() => () => {
      cleaned = true;
    });
  });

  assert.equal(typeof uninstall, "function");
  await ctx.inject("shell");
  await ctx.emit("tick");
  assert.equal(heard, 1);

  uninstall();
  assert.equal(cleaned, true);
  await ctx.emit("tick");
  assert.equal(heard, 1);
  await assert.rejects(() => Promise.race([
    ctx.inject("shell"),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("服务已被卸下，inject 不应立刻完成")), 20);
    }),
  ]), /不应立刻完成/);
});

test("异步插件在 await 之后的登记，卸载时同样会撤销", async () => {
  const ctx = createContext();
  const uninstall = await ctx.plugin(async (ctx) => {
    await Promise.resolve();
    ctx.provide("late", 42);
  });
  assert.equal(await ctx.inject("late"), 42);
  uninstall();
  await assert.rejects(() => Promise.race([
    ctx.inject("late"),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("异步登记也被卸下")), 20);
    }),
  ]), /也被卸下/);
});

test("插件加载失败时会回滚已经登记的内容", async () => {
  const ctx = createContext();
  assert.throws(() => {
    ctx.plugin((ctx) => {
      ctx.provide("half", 1);
      throw new Error("加载失败");
    });
  }, /加载失败/);

  await assert.rejects(() => Promise.race([
    ctx.inject("half"),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("失败插件不应留下服务")), 20);
    }),
  ]), /不应留下服务/);
});

test("卸载仍在等待 inject 的插件时，等待会被拒绝", async () => {
  const ctx = createContext();
  /** @type {Promise<unknown>} */
  let waiting;
  const uninstall = ctx.plugin((ctx) => {
    waiting = ctx.inject("never");
  });
  uninstall();
  await assert.rejects(() => waiting, /插件已卸载/);
});

test("get 对尚未登记的服务返回 undefined，登记后能立刻取到", () => {
  const ctx = createContext();
  assert.equal(ctx.get("llm"), undefined);
  const llm = { name: "deepseek" };
  ctx.provide("llm", llm);
  assert.equal(ctx.get("llm"), llm);
});
