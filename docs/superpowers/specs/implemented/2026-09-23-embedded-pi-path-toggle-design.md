# 内置 Pi PATH 开关设计（Settings → 通用）

## Status

已实现（2026-09-23）。两轮 grilling 拍板（Q1–Q11）后直接实施，本文随实现交付。

## 背景

内置 Pi 随 Picot 发布（`resources/pi/pi`）。开启开关后，系统级 PATH 含内置 Pi
目录，用户在任意终端（Picot 内置终端、Terminal.app、VS Code 等）可直接运行
`pi` 启动 Pi TUI。默认 Off。

## 决策记录（Dr. Lin 2026-09-23）

| # | 决策 |
|---|---|
| Q1 | 系统级（写 rc / 注册表），非仅内置终端注入 |
| Q2 | marker 块管理：On 写入/路径陈旧自动刷新/用户改动报冲突不覆盖；Off 仅删 marker 块 |
| Q3 | macOS 按 `$SHELL` 探测写单文件（zsh→`.zshrc`，bash→`.bashrc`，缺则创建）；fish v1 不支持 |
| Q4 | Windows：HKCU 用户级 `Path`（注册表 API，不用 setx 防 1024 截断）+ `WM_SETTINGCHANGE` 广播；不做系统级 Path |
| Q5 | dev 构建开关禁用（防把 `target/debug` 路径写进 rc） |
| Q6 | DB 全局偏好（`pi.pathEnabled`）+ host 控制 op；landing 可见可用 |
| Q7 | PATH 条目 **append**（`export PATH="$PATH:<dir>"` / 用户 Path 追加）——已装的用户自有 `pi` 保持优先，开关填空不劫持 |
| Q8 | App 启动自愈：偏好为 On 时校验 marker 路径，陈旧即刷新；失败仅告警不阻断启动 |
| Q9 | 卸载残留接受（死目录在 PATH 中无害），不做卸载器清理 |
| Q10 | 不支持的 shell：开关置灰 + 一行说明（比隐藏诚实、比点击后报错友好） |
| Q11 | 无需先行评审：功能面窄、边界已钉死，直接实施 |

## 实现

- **Rust** `src-tauri/src/pi_path.rs`：
  - 纯函数 `apply_to_rc_text` / `remove_from_rc_text`（marker 块语义，8 条单测：
    追加/空文件/幂等/陈旧刷新/用户改动冲突/仅删块/无块 noop/shell 映射）；
  - POSIX 文件层 `apply_posix` / `remove_posix`；
  - Windows `windows_impl`：`RegOpenKeyExW`/`RegCreateKeyExW`/`RegSetValueExW`
    读写 `HKCU\Environment\Path`（保留原值类型 REG_EXPAND_SZ/REG_SZ），
    `SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, …, "Environment", …)`
    广播；条目匹配大小写不敏感；
  - `bundled_pi_dir` 复用 `pi_launch::resolve_bundled_pi` 取二进制所在目录。
- **host op**（`main.rs` install_control_handler，`require_native_owner` 门禁）：
  - `pi_path_status` → `{dev, shellSupported, shell, enabled}`（enabled 读偏好）；
  - `pi_path_configure {enabled}` → dev 拒绝 → 写/删 → `pref_set("pi.pathEnabled")`；
  - 启动自愈：run() 内 `spawn_blocking`，On 且 release 时重跑 apply。
- **前端**：`public/settings/pi-path-toggle.js`（状态渲染 + 点击转发 + 内联错误）；
  `transport.piPathStatus/piPathConfigure`；index.html 通用页新 section（mobile 区块前）；
  app.js 与 landing.js 双入口接线；locale 切换 refresh note 文案；i18n ×4。
- **测试**：Rust 8 条纯函数单测；vitest 5 条（状态渲染三态、点击流、host 拒绝内联显示）。

## 边界与已知限制

- Windows 分支无法在本机（macOS）编译验证——本机 homebrew/rustup 双 cargo，
  msvc std 装好仍报 core 缺失；由 build-picot 的 Windows 构建路径兜底验证。
- 生效时机：仅新终端（rc 重读 / 广播后新进程）；UI 文案已注明。
- 内置终端走 rc 文件命中（`-i` 交互 shell 读 `.zshrc`/`.bashrc`），不额外注入 PTY env。
