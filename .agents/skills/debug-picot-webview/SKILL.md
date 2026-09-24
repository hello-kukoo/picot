---
name: debug-picot-webview
description: "从 agent 侧观测/调试 Picot 运行中的 WebView UI（无 CDP 可用）：注入临时诊断模块 + 页面主动回传到本地日志 + 运行时 A/B 开关。当要排查「悬停/动画/重绘/布局不生效」「某个 UI 状态看起来卡住」这类只能靠运行态观测的问题时使用。"
tags: [debug, webview, wry, wkwebview, observability, ui]
---

# 观测 Picot 运行中的 WebView

Picot 的 UI 是 WKWebView 里的 vanilla JS，**没有 CDP，没有 DOM 检查器可自动化**。
本 skill 讲怎么让 agent 拿到机器可读的运行态事实，以及怎么设计「只需要人类提供 1 个比特」的实验。

## 硬约束（实测，别重复踩）

| 想做 | 结果 |
|---|---|
| `screencapture` 截屏 | 失败：`could not create image from display`（终端无「屏幕录制」TCC 权限） |
| 合成鼠标事件 `CGEventPost` | 失败：`CGPreflightPostEventAccess()` 返回 `False`（无「辅助功能」权限） |
| CDP / Playwright 连 WKWebView | 不可用 |
| 改 `public/**` 后生效 | **debug 构建直接 serve 工作区的 `public/`**，无需重编 Rust；页面下一次导航（切 session、重启 app）即加载新文件 |
| 页面 `fetch` 到 `127.0.0.1:<port>` | 放行：`tauri.conf.json` 的 CSP `connect-src` 含 `http://127.0.0.1:*` |

推论：**像素是否更新，agent 自己测不了**。所以设计实验时必须让人类只回答 1 个比特，且用机器可读的回传承担其余全部推理。

## 三条通道

1. **屏上 overlay**（给人看）：诊断条显示当前实验状态、计数、结论。放窗口顶部居中，`pointer-events: none`，别盖住被测元素。
2. **HTTP 回传**（给 agent 看）：页面 `fetch(ENDPOINT, {mode:'no-cors', method:'POST', body: line})` 周期性上报，agent 直接读日志文件。这是主力通道——不占人类时间，可回溯。
3. **运行时 A/B**（定因）：不改代码就能切结构/切 CSS。见下。

## 配方

```bash
# 1) 起回传收集器（日志文件即 agent 的读数口）
cp <skill>/assets/collector.js /tmp/picot-diag-collector.js
(bun /tmp/picot-diag-collector.js > /tmp/picot-diag-collector.out 2>&1 &)
# 默认监听 127.0.0.1:45799，追加写 /tmp/rail-diag.log

# 2) 装诊断模块（改完要还原）
cp <skill>/assets/webview-diag.js public/tmp-webview-diag.js
# 在 public/index.html 的 bootstrap-entry.js 之后加一行：
#   <script type="module" src="tmp-webview-diag.js"></script>

# 3) 起应用（debug 构建，public/ 直接生效）
(nohup bun run dev > /tmp/picot-dev.log 2>&1 &)

# 4) 读回传
grep -o 'OVERRIDE.*' /tmp/rail-diag.log | tail
```

**收尾必须做**：删 `public/tmp-webview-diag.js`、还原 `index.html` 那一行、kill 收集器。
临时文件不要留在工作树里（`public/` 不是 gitignore 的）。

## 探针速查（每个探针切掉一个分支）

| 探针 | 切掉的分支 |
|---|---|
| `el.matches(':hover')` | 样式/命中测试是否到达该元素 |
| `document.elementsFromPoint(x,y)` | 是否被别的元素遮挡（栈顶是谁） |
| `getComputedStyle(el).backgroundColor` / `backdropFilter` | 悬停规则是否真的计算生效 |
| `getComputedStyle(child,'::after').width` | JS 写入的样式（如波形宽度）是否进了 DOM |
| `el.getBoundingClientRect()` vs `offsetParent` | 几何/包含块是否符合预期 |
| `document.getAnimations()` 过滤到该子树 | 有没有卡住的合成动画（transition/animation） |
| `new MutationObserver(trackEl).observe(..., {childList:true})` | 该子树是否在被反复重建（churn） |
| `el.offsetParent` 及其 `position/overflow` | 包含块是否在滚动容器外（layer 归属的常见坑） |

判据写法：在回传行里给一个 `verdict=` 字段，把「命中没到 / 样式没生效 / 样式生效但没画」直接算出来。agent 读一行就能定位到分支。

## 运行时 A/B（不改代码定因）

- **结构 A/B**：`main.appendChild(navEl)` / `messages.appendChild(navEl)` 互换父子——若元素是 `position:absolute` 且包含块在被挂载容器之外，**换挂点视觉位置完全不变**，只改变「滚动容器逃逸」这类 layer 归属条件。
- **属性排除**：动态插 `<style>` 覆盖可疑属性（如 `backdrop-filter`、`animation`、`transition`），逐个开关做二分。
- **触发点**：先找到人类可复现的触发动作（例：resize 窗口），协议固定为「先切开关 → 再触发 → 再观测」。开关本身会造成一次重绘，所以触发动作必须放在开关之后。

## 坑

- **键位触发不可靠**：macOS 上 `Ctrl+Shift+<digit>`、F 键可能收不到或被系统占用；实测出现过按键完全没被页面收到。改用**屏上按钮**（overlay 局部 `pointer-events: auto`）。
- **`no-cors` POST** 只用于单向上报，不要等响应。
- **上报频率**：仅在状态变化时 + 悬停期间按 0.5s 上报，否则日志被淹没。
- **别动未提交的工作**：只加临时文件 + `index.html` 一行，其余保持原样。
- **人类时间是最贵的资源**：一次交互只问一个比特，问题里明确「看什么」。
