# 六 spec 人工 E2E 测试计划（2026-09-23）

对着做一遍即可。每项填「通过 / 失败 / 跳过」，失败时按 §8 抓证据。

被覆盖的提交：

| # | Spec | 提交 |
| --- | --- | --- |
| 1 | session-scan-bounded-io | `4c73f52` |
| 2 | history-scroll-auto-load | `1282ac8` |
| 3 | session-resident-views（Phase A） | `71d6fd4` |
| 4 | anydoc-office-preview | `257a9f8` |
| 6 | provider-quota-display | `beddcda` |
| 5 | browser-pane-annotation | `419c581` |
| — | 六个 spec 的 critical review 修复 | `ca1f4db` |

## 0. 准备

### 0.1 环境

macOS，officecli 已装（`officecli --version` → 1.0.149）。**不要用 fresh home**：#6 需要真实的 `~/.pi/agent/auth.json`。

```bash
cd ~/tmp/PI/picot-v3
bun run dev
```

### 0.2 测试素材

```bash
mkdir -p /tmp/picot-e2e
cp ~/tmp/PI/picot-v3/extensions/fixtures/anydoc/*.{doc,docx,rtf,odt,ppt,pptx,odp,xls,xlsx,ods,pdf} /tmp/picot-e2e/ 2>/dev/null
ls /tmp/picot-e2e | wc -l    # 期望 13：10 个 office + text.pdf + 2 个错误 fixture
```

在 Picot 里把 `/tmp/picot-e2e` 添加为工作区，后面 §4/§5 都从这里点文件。

通用网页场景（§5.5）另开一个本地服务：

```bash
python3 -m http.server 5173 --directory /tmp/picot-e2e
```

### 0.3 观测手段

```bash
# 日志
tail -f ~/Library/Logs/com.palandata.picot.dev/Picot.log

# 渲染服务进程（§5.10 用）
pgrep -fl "officecli watch"

# host 端口（§5.7 用；也可在 dev 日志里找 http://127.0.0.1:PORT）
lsof -nP -iTCP -sTCP:LISTEN | grep -iE "picot|Picot"
```

## 1. #1 侧栏扫描双窗口（`4c73f52`）

素材：picot-v3 bucket 里已有真实大 session（44M / 28M / 22M / 14M 各一）。打开 picot-v3 工作区即可看到。

| 步骤 | 预期 |
| --- | --- |
| 1.1 侧栏滚到那些大 session，观察行内容 | 每行有名字；有首条消息预览 |
| 1.2 点 44M 那个 session 切入 | 切换在 2s 内完成，侧栏不长时间白屏 |
| 1.3 对大 session 用行内改名按钮改成 `E2E-Rename-<时间>` | 侧栏立刻显示新名（尾部窗口的 `session_info` 胜出） |
| 1.4 重启 Picot，再看该行 | 仍是新名（改名已落盘在文件尾部） |
| 1.5 对任一普通 session 改名 | 行为与改动前一致 |

失败特征：侧栏刷新卡顿数秒；大 session 名字为空；改名后仍显示旧名。

## 2. #2 历史折叠自动加载（`1282ac8`）

素材：同上的长 session。

| 步骤 | 预期 |
| --- | --- |
| 2.1 打开长 session（顶部有 history gate，历史折叠） | 只见最近若干轮 + 顶部 gate |
| 2.2 慢慢向上滚动到距顶 96px 内 | 自动加载下一批折叠历史，不必点按钮；若一批填不满视口会继续续批 |
| 2.3 继续滚到顶 | 循环直到全部加载或到顶 |
| 2.4 点 gate 上的 "Load older history" / "Load all history" | 两个按钮仍工作 |
| 2.5 在长会话里向上滚动后看右下 | **「滚动到最新消息」按钮（`#scroll-bottom-btn`）出现**；点它回到最新；回到最新后按钮消失 |
| 2.6 搜一下历史消息（若用搜索切换会话） | 搜索渲染不触发自动加载 |

失败特征：滚到顶不自动加载；向上滚动后回底按钮仍不出现（这是本次修掉的潜伏 bug）。

## 3. #3 Session resident views（Phase A，`71d6fd4`）

| 步骤 | 预期 |
| --- | --- |
| 3.1 打开 session A，记下滚动位置与已揭示的折叠批数 | — |
| 3.2 切到 session B，再切回 A | 立即恢复：滚动位置、揭示批数与离开时一致，无重新渲染闪烁 |
| 3.3 在 A 发一个要跑一阵的任务，立刻切到 B | A 在后台继续；回合结束后切回 A，新消息已经在，不需要重新加载 |
| 3.4 在外部改 A 的 session 文件（`touch` 或追加一行）后切回 A | 检测到文件 stamp 变化 → 重新渲染，不显示陈旧内容 |
| 3.5 连续切换 6 个以上不同 session，再回头切最早那个 | 最早那个按缓存淘汰策略重新渲染（不报错、不显示错乱内容） |

失败特征：切回后滚动位置丢失或跳到顶部；消息重复；显示陈旧内容。

## 4. #4 Office 原生预览（`257a9f8`）

Files 面板（右侧工具栏的 Files 按钮）里点 `/tmp/picot-e2e` 下的文件。

| 步骤 | 预期 |
| --- | --- |
| 4.1 点 `text.docx` | 只读 Markdown 预览（标题、段落、表格）；无编辑模式入口；工具条出现「内置浏览器打开」 |
| 4.2 点 `pres.pptx` | 幻灯片转 Markdown 预览 |
| 4.3 点 `sheet.xlsx` | 表格转 Markdown 预览 |
| 4.4 十个 office 后缀各点一遍（`text.doc/rtf/odt`、`pres.ppt/odp`、`sheet.xls/ods`） | 都能出预览，不出现二进制乱码 |
| 4.5 把 PDF 改名成 office 后缀：`cp text.pdf mislabeled.docx`，点它 | 明确失败提示（转换失败），**不是** PDF 原始预览，不崩溃 |
| 4.6 点 `encrypted--errors.odt` | 加密类失败提示 |
| 4.7 点 `truncated--errors.docx` | 损坏类失败提示 |
| 4.8 造一个超大文件：`python3 -c "open('/tmp/picot-e2e/big.docx','wb').write(open('/tmp/picot-e2e/text.docx','rb').read() + b'0'*(34*1024*1024))"`，点它 | 「文件过大」类提示，UI 不卡死 |
| 4.9 点 `text.pdf` | PDF 预览照旧（未被 office 分支接管） |
| 4.10 点普通 `.md`/`.txt` | 预览照旧 |
| 4.11 若手头有含远程图片的 office 文档 | 图片位置显示本地化替代文本，日志里无网络请求失败噪声 |

失败特征：白屏、卡死、乱码、PDF 走了 office 分支或 office 走了 PDF 分支。

## 5. #5 浏览器面板 + 元素标注（`419c581` + `ca1f4db`）

### 5.1 office 场景

| 步骤 | 预期 |
| --- | --- |
| 5.1.1 预览 `text.docx`，点「内置浏览器打开」 | 右侧新增 tab（🌐 图标），内容是 officecli 保真渲染；工具条有地址栏、「标注」、「刷新」、「重启渲染」 |
| 5.1.2 点「标注」，在页面上移动鼠标 | 元素高亮 + 浮标显示 `tag#id.class`、尺寸 |
| 5.1.3 点一个段落 | 弹出标注对话框，顶部显示 docPath（形如 `/body/p[4]`） |
| 5.1.4 输入「字号改大」，点「加入输入框」 | composer 出现 `<office-element file="text.docx">` 文本块，含 `path` / `selector` / `feedback` / `suggested: officecli set …` |
| 5.1.5 看该段落 | 出现编号徽标；点「刷新」重载页面后徽标仍在 |
| 5.1.6 发送那个文本块（agent 会走 officecli 技能改文档） | 预览在数秒内自动刷新呈现改动。若 agent 不配合，改用终端手动验证：`officecli set /tmp/picot-e2e/text.docx /body/p[4] --prop fontSize=18pt`，预览应自动刷新 |
| 5.1.7 用外部编辑器直接改 docx，等几秒 | 预览**不**刷新（已知边界）；点「重启渲染」后呈现最新 |

### 5.2 通用网页场景

| 步骤 | 预期 |
| --- | --- |
| 5.2.1 地址栏输入 `http://localhost:5173/` 回车 | 页面加载；地址栏与标签显示该地址 |
| 5.2.2 标注一个元素并加评论 | 附件是 `<browser-element url=…>`，含 `selector` / `size` / `styles` / `parents` / `html` |
| 5.2.3 若有 React 开发服务器（带 source map），标注 React 组件 | 附件里多一行 `source: <组件名> @ <文件>:<行>:<列>` |

### 5.3 交互边界

| 步骤 | 预期 |
| --- | --- |
| 5.3.1 进入标注后按 Esc | 退出标注模式，无附件产生 |
| 5.3.2 进入标注后 30 秒不动 | 自动退出，状态栏提示选择器不可用 |
| 5.3.3 标注模式下点页面里的按钮/链接 | 不触发页面跳转（捕获阶段被拦截） |
| 5.3.4 切到另一个 tab 再切回，滚动页面位置 | 页面状态保留（webview 存活，只做隐藏） |
| 5.3.5 关掉这个 browser tab | tab 消失，无残留报错 |

### 5.4 安全边界（重点）

先从 §0.3 取 host 端口 `PORT`。

| 步骤 | 预期 |
| --- | --- |
| 5.4.1 地址栏输入 `http://localhost:PORT/` | 被拒（无法打开 / 不允许） |
| 5.4.2 输入 `http://127.0.0.1:PORT/` | 被拒 |
| 5.4.3 输入 `http://0.0.0.0:PORT/` 与 `http://[::1]:PORT/` | 均被拒 |
| 5.4.4 输入本机 LAN 地址 + 同端口（`ipconfig getifaddr en0` 取值） | 被拒 |
| 5.4.5 输入 `http://127.0.0.1:<别的端口>/`（例如 officecli watch 的端口） | 允许 |
| 5.4.6 在外部页面里放一个跳转 host 的链接并点它 | 导航被拒，page 停在原处 |
| 5.4.7 页面里 `target=_blank` 链接 | 不弹新窗口 |

### 5.5 进程与多窗口（`ca1f4db` 修复项）

| 步骤 | 预期 |
| --- | --- |
| 5.5.1 `pgrep -fl "officecli watch"` 记下 pid | 与打开的 office tab 数量对应 |
| 5.5.2 关闭一个 office browser tab | 对应 pid 消失 |
| 5.5.3 同一文件开两次（关掉再开） | 只有一个 watch 进程（按文件去重） |
| 5.5.4 退出 Picot | `pgrep -fl "officecli watch"` 无输出 |
| 5.5.5 快速连点两次「内置浏览器打开」 | 不出现重复 tab；不留下孤儿 watch 进程 |

### 5.6 officecli 缺失（可选）

```bash
sudo mv /opt/homebrew/bin/officecli /opt/homebrew/bin/officecli.bak   # 或临时改 PATH
```

点「内置浏览器打开」应提示安装 officecli。做完改回来。

## 6. #6 Provider 配额（`beddcda` + `ca1f4db`）

本机已配 `openai-codex` / `opencode-go` / `zai-coding-cn`。

| 步骤 | 预期 |
| --- | --- |
| 6.1 Settings → Usage | 出现「提供方配额」区块，3 张卡片：OpenAI Codex、OpenCode、Z.ai；每张有窗口条与更新时间 |
| 6.2 点「刷新」 | 短暂「刷新中…」后更新 |
| 6.3 看是否出现 deepseek / minimax / moonshot / ollama 卡片 | 不出现（未配置就不显示，也不显示 0% 假数据） |
| 6.4 断网后点刷新 | 各卡片显示closed错误码对应文案（暂时不可用）；30 分钟内的瞬时失败保留上一次成功值 |
| 6.5 若某卡片显示「需要重新登录」 | 重新登录后刷新应恢复正常 |
| 6.6 落到 landing 页的 Usage | 同一区块也在（landing 用自己的 ConfigGateway） |
| 6.7 点「重置额度（剩 N 个）」 | ⚠️ **会真实消耗一个 Codex reset credit，不可逆。** 仅在愿意消耗时做：确认后出 toast「额度已重置」，窗口条刷新，剩余数减 1 |
| 6.8 （可选，需 DB 访问）查 `reset_credit_operations` 表 | 该操作一条 `settled`；并发点两次不会出现两条 `pending` |

余额型 provider（无百分比概念）应显示余额文本而不是假的百分比条。

## 7. 已知边界（这些不算失败）

- **#1**：首条 user 消息落在 64 KiB 之外 → 无消息预览；settled 名距 EOF 超过 256 KiB → 无名字。两条降级已记入 `ARCHITECTURE.md`。
- **#4**：输出上限在转换后判定；转换期间的内存峰值取决于 anydoc 内部限额与 2 路并发 permit；无硬取消（abort 只是忽略响应）。
- **#4**：Windows 侧 release 体积与手测未做（没有 Windows 机器）。
- **#5**：一期不做元素截图、普通网页徽标 overlay、历史/书签、agent 反向自动化；officecli 外部编辑不自动刷新。
- **#3**：只实施 Phase A（切换 no-op、滚动恢复、后台增量、stamp 失效）。Phase B/C 按拍板未做。
- **#6**：Windows 未测。

## 8. 结果记录与抓证据

| # | 项 | 结果 | 备注 |
| --- | --- | --- | --- |
| 1 | 侧栏扫描 | | |
| 2 | 折叠自动加载 | | |
| 3 | resident views A | | |
| 4 | Office 预览 | | |
| 5 | 浏览器面板 + 标注 | | |
| 6 | Provider 配额 | | |
| — | review 修复（§5.4/5.5、§6.8） | | |

失败时收这四样：

```bash
tail -200 ~/Library/Logs/com.palandata.picot.dev/Picot.log
pgrep -fl "officecli watch"
pgrep -fl "picot-v3|bun.*dev" | head
# 外加：复现步骤、截图、当时打开的 URL / 文件路径
```

崩溃另附 `~/Library/Logs/DiagnosticReports/` 下对应的 `.ips`。
