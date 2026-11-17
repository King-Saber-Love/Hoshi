/**
 * Hoshi 的插件运行时。
 *
 * 插件是一个函数，接收上下文和可选配置。
 * 它可以提供服务、注册事件处理器，并登记可撤销的 effect。
 * 调用 plugin() 返回的卸载函数时，该插件在加载期间登记的一切都会按相反顺序撤销。
 */

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * @typedef {object} HoshiContext
 * @property {(plugin: HoshiPlugin, config?: object) => ( (() => void) | Promise<() => void> )} plugin
 * @property {(name: string, service: unknown) => () => void} provide
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
 * 正在加载的插件作用域。
 * 用 AsyncLocalStorage 保存，这样插件内部即使有 await，
 * provide / on / effect 仍然会记到正确的插件头上。
 * @type {AsyncLocalStorage<Scope>}
 */
const scopeStorage = new AsyncLocalStorage();

/**
 * @typedef {object} Scope
 * @property {boolean} disposed
 * @property {Array<() => void>} cleanups
 * @property {(cleanup: () => void) => void} add
 * @property {() => void} dispose
 */

/**
 * 创建一个作用域：用来收集「以后怎么撤销」的函数。
 * 卸载时按相反顺序执行，后登记的先撤销。
 * @returns {Scope}
 */
function createScope() {
  /** @type {Scope} */
  const scope = {
    disposed: false,
    cleanups: [],
    // 记下一条撤销函数；如果作用域已经卸了，就立刻执行，避免漏清理。
    add(cleanup) {
      if (scope.disposed) {
        cleanup();
        return;
      }
      scope.cleanups.push(cleanup);
    },
    // 只卸一次。splice(0) 取出全部清理函数并清空数组，reverse() 反过来执行。
    dispose() {
      if (scope.disposed) return;
      scope.disposed = true;
      const list = scope.cleanups.splice(0).reverse();
      for (const cleanup of list) cleanup();
    },
  };
  return scope;
}

/**
 * 创建根插件上下文。每次调用都得到一份互不干扰的实例。
 * @returns {HoshiContext}
 */
export function createContext() {
  // 已登记的服务：名字 -> 实例。例如 "llm" -> 某个模型适配器。
  /** @type {Map<string, unknown>} */
  const services = new Map();
  // 正在等待某个服务的 inject 调用。服务到来后，这里的 resolve 会被逐个叫醒。
  /** @type {Map<string, Array<{ resolve: (value: unknown) => void, reject: (reason: Error) => void }>>} */
  const waiters = new Map();
  // 事件名 -> 一组处理函数。同一个事件可以挂多个处理器。
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  // 不在任何 plugin() 里登记的内容，都记到这个根作用域上。
  const rootScope = createScope();

  /**
   * 取出「当前正在加载哪个插件」的作用域。
   * getStore() 若为空（说明没在 plugin() 里），就退回根作用域。
   * ?? 只在左边是 null 或 undefined 时才用右边。
   * @returns {Scope}
   */
  function currentScope() {
    return scopeStorage.getStore() ?? rootScope;
  }

  /**
   * 把一条撤销函数记到当前作用域，并返回同一个函数给调用方。
   * 调用方可以提前单独撤销；closed 标志保证清理逻辑最多执行一次。
   * @param {() => void} cleanup
   * @returns {() => void}
   */
  function track(cleanup) {
    let closed = false;
    const dispose = () => {
      if (closed) return;
      closed = true;
      cleanup();
    };
    currentScope().add(dispose);
    return dispose;
  }

  /** @type {HoshiContext} */
  const ctx = {
    /**
     * 加载一个插件。
     * 会新建一个作用域，并在这个作用域里执行插件函数；
     * 插件期间调用的 provide / on / effect，卸载时都会被撤销。
     * 返回值是卸载函数。如果插件本身是 async 的，则返回 Promise，需先 await 再拿到卸载函数。
     */
    plugin(pluginFn, config = {}) {
      if (typeof pluginFn !== "function") {
        throw new Error("plugin 需要一个函数");
      }
      const scope = createScope();

      const run = () => {
        try {
          const result = pluginFn(ctx, config);
          // 若插件返回了 Promise（写成了 async 函数），等它完成后再交出卸载函数。
          // 失败则先回滚已经登记的内容，再把错误抛出去。
          if (result && typeof result.then === "function") {
            return Promise.resolve(result).then(
              // 这里是「返回一个函数」：() => scope.dispose()
              // 调用方以后执行这个函数，才会真正卸载。
              () => () => scope.dispose(),
              (error) => {
                scope.dispose();
                throw error;
              },
            );
          }
          return () => scope.dispose();
        } catch (error) {
          scope.dispose();
          throw error;
        }
      };

      // 在这段 run（以及里面的 await 后续代码）执行期间，currentScope() 都能取到上面的 scope。
      return scopeStorage.run(scope, run);
    },

    /**
     * 按名字登记一项服务，供其他插件 inject。
     * 同名只能登记一次。若已有人在等待这个名字，会立刻把服务交给他们。
     * 返回值为撤销函数：调用后会从看板里撤掉这项服务。
     */
    provide(name, service) {
      if (typeof name !== "string" || name.length === 0) {
        throw new Error("provide 需要非空的服务名");
      }
      if (services.has(name)) {
        throw new Error(`服务 "${name}" 已经注册`);
      }
      services.set(name, service);
      const pending = waiters.get(name);
      if (pending) {
        waiters.delete(name);
        for (const waiter of pending) waiter.resolve(service);
      }
      return track(() => {
        // 只撤掉自己登记的那一份，避免误删后来顶上的同名服务。
        if (services.get(name) === service) {
          services.delete(name);
        }
      });
    },

    /**
     * 按名字取一项服务，返回 Promise。
     * 已经登记则立刻得到；还没有则挂起，等某次 provide 再结束。
     * 如果等待期间插件被卸载，这个 Promise 会被拒绝，以免永远挂着。
     */
    inject(name) {
      if (typeof name !== "string" || name.length === 0) {
        return Promise.reject(new Error("inject 需要非空的服务名"));
      }
      if (services.has(name)) {
        return Promise.resolve(services.get(name));
      }
      return new Promise((resolve, reject) => {
        let pending = waiters.get(name);
        if (!pending) {
          pending = [];
          waiters.set(name, pending);
        }
        const waiter = { resolve, reject };
        pending.push(waiter);
        track(() => {
          const list = waiters.get(name);
          if (list) {
            const index = list.indexOf(waiter);
            if (index >= 0) list.splice(index, 1);
            if (list.length === 0) waiters.delete(name);
          }
          reject(new Error(`等待服务 "${name}" 时插件已卸载`));
        });
      });
    },

    /**
     * 监听一个事件，返回取消订阅函数。
     * 之后 emit / waterfall 这个事件名时，都会调用这里登记的 handler。
     */
    on(event, handler) {
      if (typeof event !== "string" || event.length === 0) {
        throw new Error("on 需要非空的事件名");
      }
      if (typeof handler !== "function") {
        throw new Error("on 需要一个处理函数");
      }
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
      return track(() => {
        set.delete(handler);
        if (set.size === 0) listeners.delete(event);
      });
    },

    /**
     * 发出一个通知型事件：所有处理器并行执行。
     * ...args 表示事件名后面的参数会原样传给每个 handler。
     * allSettled 会等全部结束（成功或失败都算），一个抛错不会拦住其他处理器。
     * 若有失败，等大家都跑完后再把错误抛出。
     */
    async emit(event, ...args) {
      // 先复制一份处理器列表，避免执行过程中有人取消订阅而影响本次遍历。
      // ?? [] 表示这个事件还没人听时，就当成空列表。
      const handlers = [...(listeners.get(event) ?? [])];
      const results = await Promise.allSettled(
        // 写成 async，是为了把同步 throw 也变成 rejected Promise，好让 allSettled 收集到。
        handlers.map(async (handler) => handler(...args)),
      );
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, `事件 "${event}" 的多个处理器失败`);
      }
    },

    /**
     * 发出一个加工型事件：按注册顺序把值传下去。
     * 每个 handler 收到当前值，可以返回新值；返回 undefined 表示不修改，继续往下传。
     * 没有处理器时，原样返回初始值。
     */
    async waterfall(event, value, ...rest) {
      const handlers = [...(listeners.get(event) ?? [])];
      let current = value;
      for (const handler of handlers) {
        const next = await handler(current, ...rest);
        if (next !== undefined) current = next;
      }
      return current;
    },

    /**
     * 立刻执行 setup，并把它返回的清理函数登记下来。
     * setup 可以不返回清理函数；这时 effect 仍返回一个空的撤销函数，调用它不会出错。
     */
    effect(setup) {
      if (typeof setup !== "function") {
        throw new Error("effect 需要一个 setup 函数");
      }
      const cleanup = setup();
      if (typeof cleanup !== "function") {
        return () => {};
      }
      return track(cleanup);
    },
  };

  return ctx;
}
