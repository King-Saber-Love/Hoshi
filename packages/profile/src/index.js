/**
 * 加载一份命名 profile（hoshi.yml 以及补丁），并应用到上下文上。
 *
 * @param {string | URL} path
 * @returns {Promise<object>}
 */
export function loadProfile(path) {
  throw new Error("TODO: @hoshi/profile loadProfile");
}

/**
 * 应用已加载的 profile：把列出的插件挂到上下文上。
 * @param {import("@hoshi/runtime").HoshiContext} ctx
 * @param {object} profile
 * @returns {Promise<void>}
 */
export function applyProfile(ctx, profile) {
  throw new Error("TODO: @hoshi/profile applyProfile");
}
