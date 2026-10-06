/**
 * Custom error class that extends the built-in `Error` class.
 * This class adds an error code to distinguish different types of errors.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 2026-10-06：**不再继承 `@kabeep/exception`**（改继承内置 `Error`）
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ## 为什么改（实测，不是推测）
 *
 * 原实现是 `class NodeError extends Exception`（`@kabeep/exception`）。
 * 在我们的运行环境（**bun**）下，**该基类的构造函数自己就会抛 TypeError**：
 *
 *     TypeError: this.column is not a function. (In 'this.column()', 'this.column' is 15)
 *         at calc (@kabeep/exception/dist/index.js:332:26)
 *         at opening (@kabeep/exception/dist/index.js:243:24)
 *         at new NodeError (src/utils/node-error.ts:23)
 *
 * 机制：`@kabeep/exception` 的 `column()` 是**原型上的方法**
 * （`dist/index.js:340`），但运行时 `this.column` 是个**数字**（终端列数 15）
 * —— 被某个实例字段遮蔽了。于是 `calc()` 里 `this.column()` 直接崩。
 *
 * ## 为什么这个 bug 特别有害
 *
 * **它在"构造错误对象"这一步就抛了** ⇒ 于是：
 *
 *     本来要报的错误消息（如「A Nexus Mods personal API key is required…」）
 *     **在诞生那一刻就被销毁**，调用方看到的是 `this.column is not a function`。
 *
 * ⇒ **错误信息完全与真因无关**。实测：调 `bh_search_nexusmods` 且缺
 *   `NEXUS_API_KEY` 时，返回的就是这个 `this.column` 报错 ——
 *   排障时会一路查 GraphQL、查依赖，**而真因只是"没设 key"**。
 *
 * ## 为什么改成内置 `Error` 是安全的（已核实）
 *
 * 1. 全仓库**没有任何代码**用 `@kabeep/exception` 的专属能力
 *    （`palette()` / `opening()` / `divide()` 实测各 **0 处**）；
 * 2. 唯一的 import 就是本文件（L1）；
 * 3. `NodeError` 对外的契约只有两条 —— **`.message`** 与 **`.code`**，
 *    两者内置 `Error` 都能承载（`code` 是本类自己的公开字段）；
 * 4. 原构造器传的第二个参数 `'black.bgRed'` **只影响终端着色**，
 *    不参与任何逻辑 ⇒ 丢掉它不影响行为。
 *
 * ## 边界（如实）
 *
 * * 这**不是**我们的 bug，是 `@kabeep/exception` 在 bun 下的兼容性问题；
 *   本改动是**绕开**它，不是修它（我们不该改第三方包）。
 * * 代价：错误在终端里**不再有红底着色**（纯文本）。这是刻意的取舍 ——
 *   **能看见真消息**远比"好看"重要。
 */
class NodeError extends Error {
    /**
     * Creates an instance of `NodeError`.
     *
     * @param {string} message - The error message.
     * @param {NodeJS.ErrnoException['code']} [code='EUNKNOWN'] - The error code. Defaults to 'EUNKNOWN' if not provided.
     */
    constructor(
        message: string | Error,
        public code: NodeJS.ErrnoException['code'] = 'EUNKNOWN',
    ) {
        // 保持与原实现一致的语义：传 Error 对象时取它的 message，否则直接用
        super(message instanceof Error ? message.message : String(message));
        this.name = 'NodeError';
    }
}

export default NodeError;
