# 浏览器面板与元素标注：源码调试 + Office 办公双场景

**状态：** Implemented — 2026-09-23（Phase 1 + 2 全量；三期项按 spec 不做）

实施记录：Rust `browser_pane.rs`（child webview 管理 + URL 白名单 + eval_with_callback 桥[Windows 异常靠包装脚本回传] + 窗口销毁清扫）+ `officecli_watch.rs`（canonical 去重 + SIGTERM 清场 + watch mark）+ host_server 11 个 owner 门禁 data op + main.rs 注入/退出钩子。JS `browser-pane/` 四模块：pane-manager（ResizeObserver→rAF 矩形同步）、element-selector（Paseo IIFE 移植 + docPath 采集 + token/超时/Esc 状态机）、browser-annotations（office/browser 双格式 + 对话框 + composer 文本块）、browser-tab-renderer（工具条 + 标注流 + watch 重启）。tab-state 支持 browser kind 持久化（url 随存）。anydoc markdown 预览工具条新增「内置浏览器打开」。i18n `files.browser.*` ×4。测试：选择器 jsdom 6 + 附件 4 + manager 5 + tab-state 3 + renderer 升级按钮 2 + Rust 7；vitest 2106 / check / check:rust 全绿。实测：docx/pptx/xlsx watch 冒烟通过（~2.5s 就绪，data-path 全命中）。真实 dev-run 视觉验证（child webview 叠加/布局同步延迟）留 Dr. Lin 走查。
**日期：** 2026-09-22
**参照：** Paseo `packages/app/src/desktop/browser/pane/`（浏览器 pane 全套）、`element-selector.electron.ts`（492 行选择器）、`attachments/types.ts::BrowserElementAttachment`；officecli 1.0.149 本机实测；Picot 既有 file-preview 面板与子进程基建。
**演化关系：** 独立于 daemon/relay spec，可并行。与 `2026-09-17-anydoc-office-preview-design.md`（Approved 未实施）构成**升级流水线**：点击 office 文件先走 anydoc markdown 只读预览，preview 面板提供「内置浏览器打开」入口升级到本 spec 的 browser tab（officecli watch 渲染 + 标注闭环）。两 spec 独立实施、互不阻塞。

## 1. 问题与产品定位

Picot 双用户群：

1. **工程师**——浏览器面板加载 dev server / 任意网页，元素选择 + 标注（comment）发送给 Pi agent，精准前端调试（Paseo 已验证的体验）。
2. **普通员工**——把 Picot 当办公助手：打开 docx/xlsx/pptx 即得可标注视图，「指着说」让 agent 改文档，改完自动看到结果。

两条路径共用同一套基础设施：webview 容器 + 元素选择器 + 标注附件。员工路径多一层 officecli 集成（渲染服务 + 文档坐标闭环）。

**关键前提（已实测）**：officecli 渲染的 HTML 自带 `data-path` 文档树锚点，与 `officecli set/add` 命令的路径同源。标注由此从 Paseo 的「DOM 描述」升级为「可直接执行的修改坐标」——agent 不猜 DOM，直接 `officecli set file.docx /body/p[4] --prop …`。

## 2. 已验证事实

### Paseo 侧（源码核实）

| 事实 | 证据 |
| --- | --- |
| 选择器 = `executeJavaScript` 注入自包含 IIFE：hover 高亮 + 浮标（tag#id.class + React 组件名 + 尺寸）、capture 阶段阻断页面交互、点击采集（selector/attributes/outerHTML 2000/computedStyles 15 项/boundingRect/**React fiber 源码位置**/parentChain 5/children 摘要 8/url） | `element-selector.electron.ts:150-380` |
| 回传：结果挂 `window.__paseoSelectorResult`，UI 侧 200ms 轮询；session token 防串台；Esc 取消；30s 超时 | 同上 `watch`/`poll` |
| 标注流程：选中 → 弹 comment 对话框 → `BrowserElementAttachment` 进 composer → 发送时 `<browser-element url=…>` 结构化块（source/selector/text/size/styles/parents/feedback/html 截断） | `index.electron.tsx:219-295` |
| 已标注元素画编号徽标（overlay 按 selector 匹配，rAF 跟随滚动） | 同上 `BrowserAnnotationMarker` |
| 元素截图：host 侧 `captureElement` 按 boundingRect 裁剪 → attachment store | 同上 1080-1100 |

### officecli 侧（本机实测，1.0.149）

| 事实 | 证据 |
| --- | --- |
| `view <file> html` 输出自带 `data-path="/body/p[N]"`（officecli get/set/add 的文档树路径），另有 `data-section-idx`/`data-col-twips` | 实测 docx 渲染输出 |
| `watch <file> [--port]` 起预览服务：stdout `Watch: http://localhost:26315` 可解析；渲染页带 data-path；**officecli 修改文档时自动刷新**（外部编辑不检测） | 实测 HTTP 200 + stdout |
| `watch mark <file> <path>` 服务端打标（返回 `Marked /body/p[1] (id=1)`）；`goto` 经 SSE 滚动所有查看器 | 实测 |
| agent 编辑通道：`set/add/remove/move/swap/query` + resident 进程（`open`/`save`，空闲 2-10s 自动 flush）——officecli 自身修改即可触发 watch 刷新 | `officecli --help` |
| officecli 是上游开源项目（github.com/iOfficeAI/OfficeCLI），锚点零改动可用；本地技能包（officecli-skills）已有 | brew info |

### Picot 侧（源码核实）

| 事实 | 证据 |
| --- | --- |
| Tauri 2；主窗口经 `WebviewWindowBuilder` + capability init script + `on_navigation`（exact-origin 授权）+ `on_new_window(Deny)` 创建 | `main.rs:604-618`、`Cargo.toml:21` |
| prompt 通道原生支持 images（`payload.images`），composer 已有 image attachment 基建（选择/预览/粘贴） | `app/prompt-delivery.js:76`、`composer-image-attachments.js` |
| 右侧 file-preview 面板有 per-workspace 持久化 tab 状态（`file-tab-state.js`），渲染器分派（code/markdown/pdf/html） | `file-preview-panel.js`、`file-preview-renderers.js` |
| 子进程基建：child_supervision 注册表 + 启动清扫 | `child_supervision.rs` |

## 3. 总体架构

```
┌─ 主窗口（host origin WebView，capability）────────────────┐
│  file-preview 面板（tab 容器，现有）                          │
│  ┌─ browser tab（新 tab 类型）──────────────────────┐      │
│  │  [child webview：officecli watch URL / 任意 URL]  │      │
│  │   · 无 capability init script（非 owner）          │      │
│  │   · 工具条：标注模式 / 截图 / 刷新 / URL 栏        │      │
│  └──────────────┬──────────────────────────────────┘      │
└─────────────────┼─────────────────────────────────────────┘
                  │ eval() 注入选择器 / 轮询取回
          元素选择器（Paseo 脚本移植 + data-path 采集）
                  │ 标注对话框（comment）
          composer attachment（browser-element / office-element）
                  │ prompt + images
          Pi agent → bash + officecli 技能 → set/add
                  │ resident 自动 flush
          officecli watch 检测自身修改 → SSE 刷新 → 用户看到
```

## 4. Phase 1：浏览器 tab 容器

### 4.1 UI 载体（已拍板：file preview 区域）

file-preview 面板新增 `browser` tab 类型。复用现有 tab 状态管理（打开/关闭/持久化/拖宽），改动最小。主区分栏 pane（Paseo workspace-tab 形态）留待验证后作为二期演进。

### 4.2 webview 形态

Tauri 无 DOM 内嵌 webview；用 `tauri::webview::WebviewBuilder` 在主窗口内建 child webview，原生层叠加，位置/尺寸跟 panel 的 DOM rect 同步（ResizeObserver → 自定义命令 → `set_position/set_size`）。已知代价：布局同步延迟/边缘闪烁，验收标准里明确（§10）。备选（若 child webview 体验不达标）：独立 `WebviewWindow` 以面板同等定位弹层。

### 4.3 安全边界（写入 ARCHITECTURE）

- 外部 webview **不带 capability 初始化脚本**——它不是 owner，没有任何 host 控制权。
- `on_navigation`：deny host origin（防外部页跳回 host 窃取窗口上下文）；其余放行（含跳转）。
- `on_new_window`：Deny（一期；target=_blank 显示提示）。
- 一期 URL 白名单：officecli watch URL（host 分配的 loopback:port）+ 用户显式输入的 URL。无历史/书签。

### 4.4 office 文件打开流（已拍板：preview → 按钮升级）

1. 点击 office 文件 → **anydoc markdown 只读预览**（2026-09-17 spec 的路径，不依赖 officecli，快、零外部进程）。
2. 预览面板工具条增加按钮/菜单项**「内置浏览器打开」**：host `officecli watch <file> --port <分配>`（child_supervision 注册）→ 解析 stdout `Watch: http://…` → browser tab 加载并切前台。无 officecli 时按钮置灰 + tooltip 提示安装。
3. 文件关闭/tab 关闭 → `officecli unwatch`；崩溃 → 面板错误态 + 一键重启。多文件多 watch 实例（每文件独立端口，从空闲端口池分配）。

入口分工：anydoc = 快速静览（零依赖、十格式）；browser tab = 深度场景（保真渲染 + 标注 + agent 闭环，需 officecli，格式以 officecli 支持面为准——实施前对 xlsx/pptx 各做一轮冒烟）。

## 5. Phase 2：元素选择与标注

### 5.1 选择器脚本（移植 + 增强）

Paseo IIFE 原样移植（纯 DOM JS，零依赖），增强一处：

```js
var pathEl = el.closest('[data-path]');
var docPath = pathEl ? pathEl.dataset.path : null;
```

officecli 渲染页必命中 `docPath`；普通网页为 null。React fiber 源码位置挖掘保留（dev server 场景对工程师有直接价值）。

### 5.2 注入与回传

`webview.eval(script)` 注入；结果轮询同 Paseo（`window.__picotSelectorResult` + 200ms poll + session token + 30s 超时 + Esc 取消）。

### 5.3 标注附件（新 composer attachment 类型）

选中 → 标注对话框（comment 输入；office 文件时显示命中的 docPath）→ 附件进 composer 预览区 → 随 prompt 发送。两种格式：

**office 文件（docPath 命中）——可执行坐标：**

```
<office-element file="报告.docx">
  path: /body/p[4]
  selector: [data-path="/body/p[4]"]
  text: "第三季度营收分析"
  styles: font-size: 24pt; text-align: center; …
  feedback: <用户 comment>
  suggested: officecli set 报告.docx /body/p[4] --prop fontSize=18pt
</office-element>
```

（suggested 为提示性示例，agent 自行决定具体命令。）

**普通网页——Paseo 格式：** `<browser-element url=…>`（source/selector/text/size/styles/parents/feedback/html），字段与格式对齐 Paseo，便于沿用其打磨过的信息密度。

### 5.4 徽标（badge）

- office 文件：`officecli watch mark <file> <path>`（服务端权威，刷新后仍在；agent 也能 `goto` 滚动定位）。
- 普通网页：二期（Paseo 式 overlay + rAF 跟随）。

### 5.5 不做（一期）

元素截图（需 WKWebView `takeSnapshot` 自定义命令 + 裁剪，二期）；普通网页徽标；历史/书签；agent 反向自动化（Paseo 22 命令，三期参照）。

## 6. Phase 3（三期）：agent 反向自动化与深度闭环

- agent 经 host 反向 RPC 操作 webview（navigate/click/fill/snapshot/evaluate…，协议参照 Paseo `browser-automation` 22 命令裁剪）。
- 普通网页徽标 overlay；`goto` 联动（agent 修完自动滚动到改动处）。
- 与 daemon/relay spec 的通道基建合流点：远程员工手机上看 office 预览 + 标注。

## 7. 测试计划

- 选择器脚本：vitest + jsdom（脚本在 jsdom 可跑：hover/click/Esc/采集字段/data-path closest 采集）。
- 注入与轮询：stub `webview.eval`，断言 token 防串台、超时、取消。
- 附件：两种 formatted 格式快照测试；composer 预览渲染；随 prompt 发送含 images 通道。
- watch 生命周期：spawn/端口分配/stdout 解析/unwatch/崩溃重启/多实例互不串台（child_supervision 注册断言）。
- 安全：外部 webview 无 capability；on_navigation deny host origin 回跳；URL 白名单。
- 端到端（真实 officecli）：打开 docx → 标注 → attachment → agent 模拟（直接跑 officecli set）→ watch 自动刷新 → mark 徽标呈现。
- `bun run check` + `check:rust` 全绿；ARCHITECTURE 新增外部 webview 边界章节。

## 8. 验收条件

- 工程师：浏览器 tab 打开 localhost dev server，选中元素 + comment 发给 agent，附件含完整定位上下文（React 页含源码位置）。
- 员工：点击 docx → markdown 预览即现；「内置浏览器打开」→ 保真渲染；选中段落 + comment「字号改大」→ agent 执行 officecli set → 预览数秒内自动刷新呈现结果，徽标仍在。
- 外部页面无法以任何方式触达 host 能力（导航回跳被拒）。
- 旧 file-preview 静览路径不受影响。

## 9. 已拍板项（2026-09-22 Dr. Lin）

1. **UI 载体 = file preview 区域**：browser tab 先放右侧面板。
2. **office 入口 = preview → 按钮升级**：点击先 anydoc preview，preview panel 加「内置浏览器打开」按钮/菜单项（§4.4）。
3. **普通网页标注同期交付**：与 office 场景同一套脚本，仅 formatted 分支不同。

## 10. 风险

- child webview 与 panel 布局同步的原生层延迟（最大工程不确定点；§4.2 备选弹层兜底）。
- xlsx/pptx 渲染保真度取决于 officecli 上游（docx 已实测；xlsx/pptx 实施前各做一轮冒烟）。
- officecli watch 外部编辑不检测：用户用 Word 直接改文件时预览不刷新——一期在 tab 上提示「外部修改请手动刷新」，刷新即重渲染。
