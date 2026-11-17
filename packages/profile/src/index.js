/**
 * @hoshi/profile：从 hoshi.yml 加载一份命名的插件组合，再应用到上下文上。
 *
 * 这个包只负责「读配置 + 按名字挂插件」，不实现具体工具或模型。
 * 短名（tools、approvals、shell 等）通过 catalog 对照到工厂函数；
 * catalog 由 CLI / Web 等壳传入，这样壳可以换默认插件，测试也可以塞假插件。
 * 名字不在 catalog 里时，再按 Node 模块说明符去 import，所以新增插件不必改这个包。
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

/** 在目录里查找 profile 时，按这个顺序认文件名。 */
export const PROFILE_FILENAMES = ["hoshi.yml", "hoshi.yaml"];

const PROFILE_KEYS = new Set(["name", "system", "model", "plugins"]);
const ENTRY_KEYS = new Set(["id", "plugin", "config", "disabled"]);

/**
 * @typedef {object} ProfilePluginEntry
 * @property {string} [id]  可选标识，给补丁按 id 对齐用
 * @property {string} plugin  catalog 短名，或一个 Node 模块说明符 / 相对路径
 * @property {Record<string, unknown>} config
 * @property {boolean} disabled
 */

/**
 * @typedef {object} HoshiProfile
 * @property {string} [name]
 * @property {string} [system]
 * @property {string} [model]
 * @property {string} [source]  来源文件的绝对路径，供相对模块路径解析
 * @property {ProfilePluginEntry[]} plugins
 */

/**
 * 在目录下寻找 hoshi.yml / hoshi.yaml。只看这一层，不向父目录走。
 * @param {string} dir
 * @returns {Promise<string | undefined>} 找到则返回绝对路径
 */
export async function findProfile(dir) {
  const root = path.resolve(dir);
  for (const filename of PROFILE_FILENAMES) {
    const candidate = path.join(root, filename);
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
  }
  return undefined;
}

/**
 * 读取一份 profile。`path` 可以是文件，也可以是含 hoshi.yml 的目录。
 * `options.patches` 里的文件会按顺序叠上去：同 id / 同名插件合并 config，新插件追加到末尾。
 *
 * @param {string | URL} pathLike
 * @param {{ patches?: Array<string | URL> }} [options]
 * @returns {Promise<HoshiProfile>}
 */
export async function loadProfile(pathLike, options = {}) {
  const file = await resolveProfilePath(pathLike);
  const profile = parseProfile(await readFile(file, "utf8"), { source: file });
  for (const patchLike of options.patches ?? []) {
    const patchFile = await resolveProfilePath(patchLike);
    const patch = parseProfile(await readFile(patchFile, "utf8"), { source: patchFile });
    applyProfilePatch(profile, patch);
  }
  return profile;
}

/**
 * 把 YAML 文本解析成 profile 对象。
 * @param {string} text
 * @param {{ source?: string }} [options]
 * @returns {HoshiProfile}
 */
export function parseProfile(text, options = {}) {
  let raw;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const where = options.source ? `（${options.source}）` : "";
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法解析 profile YAML${where}: ${reason}`);
  }
  return normalizeProfile(raw, options);
}

/**
 * 把原始对象（YAML / JSON）规范成统一的 profile 结构。
 * @param {unknown} raw
 * @param {{ source?: string }} [options]
 * @returns {HoshiProfile}
 */
export function normalizeProfile(raw, options = {}) {
  if (raw == null) {
    throw new Error(options.source ? `profile 是空的: ${options.source}` : "profile 是空的");
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("profile 必须是一个对象，顶层可包含 name、system、model、plugins");
  }

  const record = /** @type {Record<string, unknown>} */ (raw);
  for (const key of Object.keys(record)) {
    if (!PROFILE_KEYS.has(key)) {
      throw new Error(`profile 里有不认识的字段: ${key}`);
    }
  }

  return {
    name: optionalString(record.name, "name"),
    system: optionalString(record.system, "system"),
    model: optionalString(record.model, "model"),
    source: options.source,
    plugins: normalizePlugins(record.plugins),
  };
}

/**
 * 没有 hoshi.yml 时，CLI 使用的内置组合，和改配置之前硬编码挂载的列表一致。
 * @param {{ workspace?: string, system?: string, model?: string }} [options]
 * @returns {HoshiProfile}
 */
export function createDefaultProfile(options = {}) {
  const workspaceConfig = options.workspace === undefined ? {} : { workspace: options.workspace };
  return {
    name: "default",
    system: options.system,
    model: options.model,
    source: undefined,
    plugins: [
      { plugin: "tools", config: {}, disabled: false },
      { plugin: "approvals", config: {}, disabled: false },
      { plugin: "shell", config: { ...workspaceConfig }, disabled: false },
      { plugin: "filesystem", config: { ...workspaceConfig }, disabled: false },
      { plugin: "llm-deepseek", config: {}, disabled: false },
    ],
  };
}

/**
 * 把补丁叠到已加载的 profile 上：name / system / model 以补丁为准（没写的字段保持原值）；
 * 插件按 id（有的话）或 plugin 名对齐，合并 config 和 disabled，找不到就追加。
 *
 * @param {HoshiProfile} profile
 * @param {HoshiProfile} patch
 * @returns {HoshiProfile} 原对象，方便链式调用
 */
export function applyProfilePatch(profile, patch) {
  if (patch.name !== undefined) profile.name = patch.name;
  if (patch.system !== undefined) profile.system = patch.system;
  if (patch.model !== undefined) profile.model = patch.model;

  for (const entry of patch.plugins) {
    const index = findPluginIndex(profile.plugins, entry);
    if (index === -1) {
      profile.plugins.push(cloneEntry(entry));
      continue;
    }
    const current = profile.plugins[index];
    /** @type {ProfilePluginEntry} */
    const merged = {
      plugin: entry.plugin,
      config: { ...current.config, ...entry.config },
      disabled: entry.disabled,
    };
    const id = entry.id ?? current.id;
    if (id) merged.id = id;
    profile.plugins[index] = merged;
  }
  return profile;
}

/**
 * 按挂载顺序，把 profile 里未禁用的插件装到上下文上。
 *
 * catalog 是短名到工厂函数的对照表；工厂约定是 `(config) => plugin`，
 * 和现在 `ctx.plugin(approvals({ prompt }))` 的写法一致。
 * `configure` 让壳在挂载前注入运行时才知道的值，比如 API Key、工作区路径、提问函数。
 *
 * @param {import("@hoshi/runtime").HoshiContext} ctx
 * @param {HoshiProfile} profile
 * @param {{ catalog?: Record<string, Function>, configure?: (name: string, config: Record<string, unknown>, entry: ProfilePluginEntry) => Record<string, unknown> | void }} [options]
 * @returns {Promise<string[]>} 实际挂上的插件名，按顺序
 */
export async function applyProfile(ctx, profile, options = {}) {
  if (!ctx || typeof ctx.plugin !== "function") {
    throw new Error("applyProfile 需要一个 Hoshi 上下文");
  }
  if (!profile || !Array.isArray(profile.plugins)) {
    throw new Error("applyProfile 需要一份已加载的 profile");
  }

  const catalog = options.catalog ?? {};
  const configure = options.configure;
  const mounted = [];

  for (const entry of profile.plugins) {
    if (entry.disabled) continue;

    const factory = await resolvePluginFactory(entry.plugin, catalog, profile.source);
    let config = { ...entry.config };
    if (typeof configure === "function") {
      const next = configure(entry.plugin, config, entry);
      if (next !== undefined) config = next;
    }

    const plugin = factory(config);
    if (typeof plugin !== "function") {
      throw new Error(`插件 "${entry.plugin}" 的工厂函数没有返回可挂载的插件函数`);
    }
    // 异步插件（比如 MCP 要先连上服务器再登记工具）会从 plugin() 得到 Promise，必须等它完成。
    const installed = ctx.plugin(plugin);
    if (installed && typeof installed.then === "function") {
      await installed;
    }
    mounted.push(entry.plugin);
  }

  return mounted;
}

/**
 * @param {string | URL} pathLike
 * @returns {Promise<string>}
 */
async function resolveProfilePath(pathLike) {
  const resolved = path.resolve(toFilePath(pathLike));
  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`找不到 profile: ${resolved}`);
    }
    throw error;
  }

  if (info.isFile()) return resolved;
  if (info.isDirectory()) {
    const found = await findProfile(resolved);
    if (!found) {
      throw new Error(`目录里没有 hoshi.yml 或 hoshi.yaml: ${resolved}`);
    }
    return found;
  }
  throw new Error(`不是有效的 profile 路径: ${resolved}`);
}

/**
 * @param {unknown} plugins
 * @returns {ProfilePluginEntry[]}
 */
function normalizePlugins(plugins) {
  if (plugins === undefined) return [];
  if (!Array.isArray(plugins)) {
    throw new Error("plugins 必须是一个数组，按挂载顺序排列");
  }
  return plugins.map((entry, index) => normalizeEntry(entry, index));
}

/**
 * 数组项可以是字符串 `"tools"`，或 `{ plugin, config, id, disabled }`。
 * @param {unknown} entry
 * @param {number} index
 * @returns {ProfilePluginEntry}
 */
function normalizeEntry(entry, index) {
  const where = `plugins[${index}]`;
  if (typeof entry === "string") {
    const plugin = entry.trim();
    if (!plugin) throw new Error(`${where} 的插件名不能为空`);
    return { plugin, config: {}, disabled: false };
  }

  if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${where} 必须是插件名字符串，或含 plugin 字段的对象`);
  }

  const record = /** @type {Record<string, unknown>} */ (entry);
  for (const key of Object.keys(record)) {
    if (!ENTRY_KEYS.has(key)) {
      throw new Error(`${where} 里有不认识的字段: ${key}`);
    }
  }

  if (typeof record.plugin !== "string" || !record.plugin.trim()) {
    throw new Error(`${where} 缺少 plugin 字段`);
  }
  if (record.config !== undefined && (record.config == null || typeof record.config !== "object" || Array.isArray(record.config))) {
    throw new Error(`${where} 的 config 必须是对象`);
  }
  if (record.disabled !== undefined && typeof record.disabled !== "boolean") {
    throw new Error(`${where} 的 disabled 必须是布尔值`);
  }
  if (record.id !== undefined && (typeof record.id !== "string" || !record.id.trim())) {
    throw new Error(`${where} 的 id 必须是非空字符串`);
  }

  /** @type {ProfilePluginEntry} */
  const normalized = {
    plugin: record.plugin.trim(),
    config: { ...(/** @type {Record<string, unknown>} */ (record.config ?? {})) },
    disabled: record.disabled === true,
  };
  if (typeof record.id === "string") normalized.id = record.id.trim();
  return normalized;
}

/**
 * @param {ProfilePluginEntry[]} plugins
 * @param {ProfilePluginEntry} entry
 * @returns {number}
 */
function findPluginIndex(plugins, entry) {
  if (entry.id) {
    const byId = plugins.findIndex((item) => item.id === entry.id);
    if (byId !== -1) return byId;
  }
  return plugins.findIndex((item) => item.plugin === entry.plugin);
}

/**
 * @param {ProfilePluginEntry} entry
 * @returns {ProfilePluginEntry}
 */
function cloneEntry(entry) {
  /** @type {ProfilePluginEntry} */
  const cloned = {
    plugin: entry.plugin,
    config: { ...entry.config },
    disabled: entry.disabled,
  };
  if (entry.id) cloned.id = entry.id;
  return cloned;
}

/**
 * 先查 catalog，没有再 `import()`。相对路径相对 profile 文件所在目录解析。
 * @param {string} name
 * @param {Record<string, Function>} catalog
 * @param {string | undefined} source
 * @returns {Promise<Function>}
 */
async function resolvePluginFactory(name, catalog, source) {
  if (Object.hasOwn(catalog, name)) {
    const value = catalog[name];
    if (typeof value !== "function") {
      throw new Error(`catalog 里的 "${name}" 不是插件工厂函数`);
    }
    return value;
  }

  const specifier = resolveModuleSpecifier(name, source);
  let mod;
  try {
    // 动态 import 才能在运行时按配置加载用户自己的插件，而不把它们写进这个包的依赖里。
    mod = await import(specifier);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`找不到插件 "${name}"：catalog 里没有这个名字，按模块加载也失败了（${reason}）`);
  }

  if (typeof mod?.default !== "function") {
    throw new Error(`模块 "${name}" 没有默认导出工厂函数`);
  }
  return mod.default;
}

/**
 * @param {string} name
 * @param {string | undefined} source
 * @returns {string}
 */
function resolveModuleSpecifier(name, source) {
  if (name.startsWith("file:")) return name;
  if (isPathSpecifier(name)) {
    const base = source ? path.dirname(path.resolve(source)) : path.resolve(".");
    return pathToFileURL(path.resolve(base, name)).href;
  }
  return name;
}

/**
 * Windows 上相对路径可能是 `.\foo.js`，绝对路径也可能是 `D:\...`。
 * @param {string} name
 */
function isPathSpecifier(name) {
  if (path.isAbsolute(name)) return true;
  if (name.startsWith("./") || name.startsWith("../")) return true;
  if (name.startsWith(".\\") || name.startsWith("..\\")) return true;
  return false;
}

/**
 * @param {string | URL} pathLike
 * @returns {string}
 */
function toFilePath(pathLike) {
  if (pathLike instanceof URL) return fileURLToPath(pathLike);
  if (typeof pathLike === "string" && pathLike.startsWith("file:")) {
    return fileURLToPath(pathLike);
  }
  if (typeof pathLike !== "string" || pathLike.length === 0) {
    throw new Error("loadProfile 需要一个文件或目录路径");
  }
  return pathLike;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string | undefined}
 */
function optionalString(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${field} 必须是字符串`);
  }
  return value;
}

/**
 * @param {unknown} error
 */
function isNotFound(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
