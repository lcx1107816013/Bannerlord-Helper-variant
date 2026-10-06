# AGENTS.md — 给 AI 的安装/使用指南（Bannerlord.Helper 变种）

> **这是给 AI coding agent 看的**。目标：把这个仓库**装好**，并把它自带的 MCP 服务器**接进客户端**。
>
> ⚠️ **本仓库是「变种」（非官方 fork）**，上游是
> [`Gengark/Bannerlord-Helper`](https://github.com/Gengark/Bannerlord-Helper)（MIT）。
> **我们不声称与上游有隶属或背书关系**；改动清单见 [`NOTICE`](NOTICE)，
> 上游版权与许可原文保留在 [`LICENSE`](LICENSE)。
>
> ★ **本仓库保留上游 `upstream` remote**（且**已禁用它的 push**）—— 可继续跟进上游更新。

---

## 0. ★★ 第一件事：**本仓库不要放进游戏的 `Modules\`**

**硬判据**：游戏只认 `SubModule.xml` 当 mod —— **本仓库没有**（实测）。
⇒ 它是**外部 MCP 服务 + CLI 工具**，**不是 mod**，放进 `Modules\` 也**不会被加载**。

| 本仓库有什么 | 在哪 | 谁用 |
|---|---|---|
| **CLI**（`bh` 命令） | `bin/bannerlord-helper.ts` → 构建成 `dist/bannerlord-helper.js` | 人 / 脚本 |
| ★ **MCP 服务器**（**我们自己加的**，上游没有） | `mcp/server.ts`（10 个工具） | AI（MCP 客户端） |

> 📌 对比：同一项目组的 `Bannerlord-blbridge` **是** mod（它有 `module/SubModule.xml`），
> 所以**那一份**才要进 `Modules\`。**别把两者搞混。**

---

## 1. 前置

| 前置 | 必需性 | 验证 |
|---|---|---|
| **bun**（推荐）或 Node 18+ | 必需（跑 MCP / CLI） | `bun --version` / `node --version` |
| **Nexus API key** | **可选** —— 只有两个 Nexus 检索工具需要 | 见 §4 |

★ 不需要 .NET、不需要 Python、不需要游戏在运行
（本仓库**只处理汉化文件**，不操控游戏）。

---

## 2. 安装

```bash
cd <你 clone 的>\Bannerlord-Helper-variant
bun install
```

★ **MCP 服务器不需要额外构建** —— 直接由 `bun run` 起（见 §3）。

**若要 `bh` CLI**（构建产物形态）：

```bash
bun run build                # tsup 构建到 dist/
# 或从 npm 装已发布版：
npm install bannerlord-helper --global
```

⚠️ 本仓库有 **`husky` + `lint-staged`** 钩子（`pre-commit` 会跑 `npm run lint`）。
若你在**没有 `.git` 的环境**或 CI 里跑，可能需要 `HUSKY=0` 跳过。

---

## 3. ★ 把它接成 MCP 服务器

**这是本仓库作为 MCP 的正式入口**（`mcp/server.ts`，**10 个工具**）：

```jsonc
{
  "mcpServers": {
    "bannerlordhelper": {
      "command": "bun",
      "args": ["run", "mcp/server.ts"],
      "cwd": "<你 clone 的>/Bannerlord-Helper-variant",
      "env": {
        "NEXUS_API_KEY": "<可选；不给则两个 Nexus 工具会明确报缺 key>"
      }
    }
  }
}
```

### 3.1 它的 10 个工具

| 工具 | 干什么 |
|---|---|
| `bh_list_languages` | 列出支持的语言（代码 / 英文名 / 母语名 / 文件后缀） |
| `bh_resolve_language` | 解析语言代码 |
| `bh_list_local_modules` | 列出本机模组 |
| `bh_search_nexusmods` | 搜 Nexus（**需要 key**） |
| `bh_module_details` | 看某个模组的详情（**需要 key**） |
| `bh_generate_template` | 生成汉化模板（`Languages/<code>/std_*.xml`） |
| `bh_translate_module` | 翻译已有模板并写回模组 |
| `bh_create_external_translation` | 建**外部汉化模组**（独立目录 + XSLT 补丁） |
| `bh_identifier` | 识别 `ModuleData\*.xml` 里的可汉化串 |
| `bh_run_cli` | 透传调用本仓库的 CLI |

### 3.2 ⚠️ 其中两个会**写磁盘**（务必知道）

| 工具 | 会改什么 | 风险 |
|---|---|---|
| `bh_identifier` | **原地改写** `<模组>\ModuleData\*.xml` | 改的是**游戏目录里的模组文件** |
| `bh_create_external_translation` | 在 Steam `Modules\` 下**新建同级目录** | 会新增模组目录 |

★ 其余 8 个是只读或只写你指定的输出路径。
★ **建议**：不确定时先 `bh_generate_template`（只看不写游戏目录），
确认无误再动那两个。

---

## 4. Nexus API key（可选）

**只从环境变量读**，代码里**没有**任何硬编码 key：

```bash
NEXUS_API_KEY=<你的 key>          # 或 NEXUSMODS_API_KEY
```

- 申请：https://www.nexusmods.com/users/myaccount?tab=api
- **不给也能跑**，只是 `bh_search_nexusmods` / `bh_module_details` 会返回
  `EINVAL_NEXUSMOD_API_KEY` 并**告诉你缺什么、去哪申请**。

> ★ 这一条是**修出来的**：以前缺 key 时你会看到
> `this.column is not a function`（**与真因毫无关系** —— 因为错误对象在构造时就抛了，
> 真消息被销毁）。现已修好，报的是真实原因。

---

## 5. 验收（每条可机械判定）

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | 依赖装好了 | `bun install` 无错；`node_modules/` 存在 |
| 2 | MCP 能起 | `bun run mcp/server.ts` 不报缺模块（它会等 stdin，Ctrl+C 退出即正常） |
| 3 | 工具数是 10 | 客户端里 `tools/list` 能看到 10 个 `bh_*` |
| 4 | 只读工具能用 | 调 `bh_list_languages` ⇒ 返回 **13 种语言**（`EN BR CNs CNt DE FR IT JP KO PL RU SP TR`） |
| 5 | Nexus（可选） | 调 `bh_search_nexusmods{keywords:"Diplomacy"}` ⇒ 返回结果（需 key） |
| 6 | CLI（可选） | `bh --help` 或 `bun run dev -- --help` |

---

## 6. 常见失败与归因（照着查，别猜）

| 症状 | 最可能原因 | 处置 |
|---|---|---|
| `bun: command not found` | 没装 bun | 装 https://bun.sh |
| MCP 起不来、报缺模块 | 没跑 `bun install` | 先 `bun install` |
| Nexus 工具报 `EINVAL_NEXUSMOD_API_KEY` | 没设 key | 设 `NEXUS_API_KEY`（见 §4） |
| Nexus 报 HTTP 404 / 403 | 上游原端点已失效 | **本仓库已迁到官方 GraphQL v2**；若仍 404 请提 issue |
| `pre-commit` 钩子报 lint 失败 | `husky` + `lint-staged` | `npm run lint` 修；或 `HUSKY=0 git commit` |
| 汉化没生效 | 模组没重载 / 路径不对 | 重启游戏；确认改的是**装了的那个**模组目录 |

---

## 7. 卸载 / 回退（干净）

| 要回退什么 | 怎么做 |
|---|---|
| MCP 接入 | 从客户端配置里删掉 `bannerlordhelper` 条目 |
| 本仓库 | 删目录 |
| 外部汉化模组（`bh_create_external_translation` 建的） | 删 Steam `Modules\` 下那个 `<模组> <语言>` 目录 |
| CLI（若全局装过） | `npm uninstall -g bannerlord-helper` |

★ **不写注册表、不装服务、不开端口** —— 卸载就是删目录 + 删配置。
★ ⚠️ **`bh_identifier` 是原地改写** —— 若你没备份就改了模组 XML，
**回退只能靠重新安装那个模组**（或你自己的版本控制）。**先备份再跑。**

---

## 8. 相关文档

| 文档 | 讲什么 | 权威性 |
|---|---|---|
| **本文件** | ★ **本仓库装 + MCP 接入** | 本仓库维护 |
| [`README.md`](README.md) | 功能说明（**上游原文**，本仓库只在顶部加了变种声明） | 上游权威 |
| [`NOTICE`](NOTICE) | 相对上游**改了什么** + 上游署名 | 本仓库维护 |
| [`LICENSE`](LICENSE) | MIT（含上游版权原文） | — |

★ 若你是要把**四个 MCP 一起装**（推荐）：看
[`bannerlord-mcp-suite/AGENTS.md`](https://github.com/lcx1107816013/bannerlord-mcp-suite/blob/main/AGENTS.md)
—— 那里讲跨仓库的编排（哪个进 `Modules\`、哪个不进、怎么只挂一个 `chain`）。
