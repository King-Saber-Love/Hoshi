import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createContext } from "@hoshi/runtime";
import {
  PROFILE_FILENAMES,
  findProfile,
  loadProfile,
  parseProfile,
  normalizeProfile,
  createDefaultProfile,
  applyProfilePatch,
  applyProfile,
} from "@hoshi/profile";

test("PROFILE_FILENAMES 先认 hoshi.yml，再认 hoshi.yaml", () => {
  assert.deepEqual(PROFILE_FILENAMES, ["hoshi.yml", "hoshi.yaml"]);
});

test("parseProfile 支持字符串短写和对象写法", () => {
  const profile = parseProfile(`
name: demo
system: 你是助手
model: deepseek-flash
plugins:
  - tools
  - plugin: approvals
    id: ask
    config:
      policy: ask
    disabled: false
`);
  assert.equal(profile.name, "demo");
  assert.equal(profile.system, "你是助手");
  assert.equal(profile.model, "deepseek-flash");
  assert.deepEqual(profile.plugins, [
    { plugin: "tools", config: {}, disabled: false },
    { id: "ask", plugin: "approvals", config: { policy: "ask" }, disabled: false },
  ]);
});

test("parseProfile 会拒绝空文档、非法 YAML 和不认识的字段", () => {
  assert.throws(() => parseProfile(""), /profile 是空的/);
  assert.throws(() => parseProfile("plugins: ["), /无法解析 profile YAML/);
  assert.throws(() => parseProfile("foo: 1\n"), /不认识的字段: foo/);
  assert.throws(() => parseProfile("plugins: {}\n"), /plugins 必须是一个数组/);
  assert.throws(() => parseProfile("plugins:\n  - {}\n"), /缺少 plugin 字段/);
  assert.throws(() => parseProfile("name: 1\n"), /name 必须是字符串/);
});

test("createDefaultProfile 的挂载顺序和改配置之前一致", () => {
  const profile = createDefaultProfile({ workspace: "/tmp/ws", system: "sys", model: "m" });
  assert.equal(profile.name, "default");
  assert.deepEqual(profile.plugins.map((entry) => entry.plugin), [
    "tools",
    "approvals",
    "shell",
    "filesystem",
    "llm-deepseek",
  ]);
  assert.equal(profile.plugins[2].config.workspace, "/tmp/ws");
  assert.equal(profile.plugins[3].config.workspace, "/tmp/ws");
});

test("findProfile 只看当前目录，yml 优先于 yaml", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hoshi-profile-"));
  assert.equal(await findProfile(dir), undefined);

  const yamlPath = path.join(dir, "hoshi.yaml");
  await writeFile(yamlPath, "name: yaml\n", "utf8");
  assert.equal(await findProfile(dir), yamlPath);

  const ymlPath = path.join(dir, "hoshi.yml");
  await writeFile(ymlPath, "name: yml\n", "utf8");
  assert.equal(await findProfile(dir), ymlPath);
});

test("loadProfile 能读文件，也能读目录，找不到会抛错", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hoshi-profile-"));
  const file = path.join(dir, "hoshi.yml");
  await writeFile(file, "name: from-dir\nplugins: [tools]\n", "utf8");

  const fromFile = await loadProfile(file);
  assert.equal(fromFile.name, "from-dir");
  assert.equal(fromFile.source, file);

  const fromDir = await loadProfile(dir);
  assert.equal(fromDir.name, "from-dir");
  assert.equal(fromDir.source, file);

  await assert.rejects(() => loadProfile(path.join(dir, "missing.yml")), /找不到 profile/);

  const emptyDir = await mkdtemp(path.join(os.tmpdir(), "hoshi-profile-empty-"));
  await assert.rejects(() => loadProfile(emptyDir), /目录里没有 hoshi.yml/);
});

test("loadProfile 支持 URL，以及把补丁按 id 或插件名叠上去", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hoshi-profile-"));
  const file = path.join(dir, "hoshi.yml");
  const patchFile = path.join(dir, "hoshi.patch.yml");
  await writeFile(file, `
name: base
system: 原提示
plugins:
  - plugin: tools
  - id: ask
    plugin: approvals
    config:
      policy: ask
  - plugin: shell
`, "utf8");
  await writeFile(patchFile, `
name: patched
model: deepseek-flash
plugins:
  - id: ask
    plugin: approvals
    config:
      policy: never
  - plugin: shell
    disabled: true
  - plugin: filesystem
`, "utf8");

  const profile = await loadProfile(pathToFileURL(file), { patches: [patchFile] });
  assert.equal(profile.name, "patched");
  assert.equal(profile.system, "原提示");
  assert.equal(profile.model, "deepseek-flash");
  assert.deepEqual(profile.plugins, [
    { plugin: "tools", config: {}, disabled: false },
    { id: "ask", plugin: "approvals", config: { policy: "never" }, disabled: false },
    { plugin: "shell", config: {}, disabled: true },
    { plugin: "filesystem", config: {}, disabled: false },
  ]);
});

test("applyProfilePatch 会就地修改并返回同一对象", () => {
  const profile = normalizeProfile({ plugins: ["tools"] });
  const returned = applyProfilePatch(profile, normalizeProfile({
    plugins: [{ plugin: "tools", disabled: true }],
  }));
  assert.equal(returned, profile);
  assert.equal(profile.plugins[0].disabled, true);
});

test("applyProfile 按顺序挂载，跳过 disabled，configure 可改配置", async () => {
  const seen = [];
  const greet = (config) => (ctx) => {
    seen.push(["greet", config.word]);
    ctx.provide("greet", config.word);
  };
  const tools = (config) => (ctx) => {
    seen.push(["tools", config.flag]);
    ctx.provide("tools", true);
  };

  const ctx = createContext();
  const mounted = await applyProfile(ctx, {
    plugins: [
      { plugin: "tools", config: { flag: "from-yaml" }, disabled: false },
      { plugin: "skip-me", config: {}, disabled: true },
      { plugin: "greet", config: { word: "hi" }, disabled: false },
    ],
  }, {
    catalog: { tools, greet },
    configure(name, config) {
      if (name === "tools") return { ...config, flag: "from-cli" };
      return config;
    },
  });

  assert.deepEqual(mounted, ["tools", "greet"]);
  assert.deepEqual(seen, [["tools", "from-cli"], ["greet", "hi"]]);
  assert.equal(ctx.get("greet"), "hi");
});

test("catalog 里没有的名字，会按相对路径动态加载默认导出", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hoshi-profile-"));
  const pluginFile = path.join(dir, "marker-plugin.js");
  const profileFile = path.join(dir, "hoshi.yml");
  await writeFile(pluginFile, `
export default function marker(config) {
  return (ctx) => {
    ctx.provide("marker", config.value);
  };
}
`, "utf8");
  await writeFile(profileFile, `
plugins:
  - plugin: ./marker-plugin.js
    config:
      value: loaded
`, "utf8");

  const ctx = createContext();
  const profile = await loadProfile(profileFile);
  const mounted = await applyProfile(ctx, profile);
  assert.deepEqual(mounted, ["./marker-plugin.js"]);
  assert.equal(ctx.get("marker"), "loaded");
});

test("找不到插件或工厂返回值不是函数时，要给出明确错误", async () => {
  const ctx = createContext();
  await assert.rejects(
    () => applyProfile(ctx, { plugins: [{ plugin: "missing", config: {}, disabled: false }] }),
    /找不到插件 "missing"/,
  );
  await assert.rejects(
    () => applyProfile(ctx, { plugins: [{ plugin: "bad", config: {}, disabled: false }] }, {
      catalog: { bad: () => ({ not: "a plugin" }) },
    }),
    /没有返回可挂载的插件函数/,
  );
});

test("applyProfile 会等异步插件完成后再返回", async () => {
  let started = false;
  let finished = false;
  const slow = () => async (ctx) => {
    started = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    finished = true;
    ctx.provide("slow", true);
  };
  const ctx = createContext();
  const applying = applyProfile(ctx, {
    plugins: [{ plugin: "slow", config: {}, disabled: false }],
  }, { catalog: { slow } });
  assert.equal(finished, false);
  await applying;
  assert.equal(started, true);
  assert.equal(finished, true);
  assert.equal(ctx.get("slow"), true);
});
