# ADR 0002: 大段粘贴转存的存储边界

- 状态：Accepted
- 日期：2026-08-24
- 关联：v3 `c6f4e43`；实现 `extensions/paste-offload.ts`、`public/native/composer/composer-paste-offload.js`

## 背景

Composer 大段粘贴文本可转存为 workspace 内文件引用（`@path`），避免整段塞进消息。写入发生在用户机器的工作区内，属于需要明确约定的文件系统副作用。

## 决策

1. **唯一落点**：`.pi/tmp/paste-<timestamp>.txt`（workspace 相对路径）。目录自忽略（`.gitignore`: `*` + `!.gitignore`），不会污染 git 状态。
2. **硬上限**：内容 ≤ 2 MiB（`PASTE_OFFLOAD_MAX_BYTES`）；超限直接拒绝，不做截断。
3. **权限**：文件与 `.gitignore` 均以 `0o600` 创建；同秒冲突用 `wx` 标志 + `-N` 后缀重试（≤100 次），绝不覆盖既有文件。
4. **containment**：workspace root realpath 化后逐级校验——目录组件不得是 symlink，最终路径必须位于 root 之内；防 symlink 逃逸与 sibling-prefix 绕过。
5. **传输层**：经 `/picot-config write_paste_offload` bridge op 写入（bridge 持有真实 cwd）；WebView 只接收相对路径。转存进行中 composer 拒绝提交（busy guard），防止半完成引用进入会话。

## 后果

- 会话历史中的 `@.pi/tmp/paste-*.txt` 引用长期可解析（除非用户清理 .pi/tmp）；历史会话不做追溯转存。
- 该边界与 ADR 0001（OAuth）共同构成 bridge 侧文件系统/凭据副作用的完整清单。
