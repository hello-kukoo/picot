# upstream 同步（2026-09）新增功能说明

记录 `origin/private/feature-v3.3-new-arch` 分支同步 `upstream/main` 后引入的三项新功能。每节包含功能说明、用户可感知变化、关键代码与文件路径、测试覆盖与已知限制。

> 同步基线：`upstream/main` 提交 `08456b1`（Merge pull request #63 from shixin-guo/dev-mul），相对 v0.5.4 (`9b583bd`) 共 31 个新提交。合并提交 `cad3bb4` 接入本分支，修复 commit `d2ec235`、`71a206c` 跟随其后。

---

## 1. ACP 子代理内联卡片

Commit：`f207db0d8ce9a2e06a40f83ef6567d80ed68934e` — *Render ACP tasks as inline subagent cards*

### 一句话

Picot 引入了一个新的子代理执行机制：在 Pi session 还活着的时候，另起一个外部 ACP 进程去执行子任务，子任务结束后把结果回送 Pi，Pi 继续推进。

### 用户能看见的变化

#### 1.1 Composer 新增 `#` 触发器

之前输入 `#claude` 会切换整个 session 的 backend 为 Claude Code，现在不会切换：

```text
#claude fix the failing test
```

`composer-agent-menu.js` 把 `#query` 替换成 `#<token>` 前缀，光标停在 token 后，用户继续输入任务描述。

```js
const prefix = `#${agent.token ?? agent.id} `;
input.value = prefix + input.value.slice(hash.end);
input.setSelectionRange(prefix.length, prefix.length);
```

#### 1.2 主消息列表里插入一张子代理卡片

ACP 任务执行时，主消息流中插入一张可展开的 inline card：

```text
┌─ Claude Code · 12s ─────────────┐
│ Fix the failing test            │
│ ▶ Working…                       │
│ ┌─ tool: read_file ──────────┐ │
│ │ /path/to/test.js │  │
│ └────────────────────────────┘  │
│ ┌─ tool: edit_file ──────────┐  │
│ │ updated test.js            │  │
│ └────────────────────────────┘  │
│ ✦ Finished in 23s   [Send to Pi]│
└──────────────────────────────────┘
```

它**复用** Picot 自己的 `renderMarkdown`、`ToolCardRenderer`、`initCodeCopyDelegation`、`showNativeDialog`，所以视觉上跟普通 Pi turn 没差别。

#### 1.3 子代理的权限弹窗用 Picot 自己的 dialog

```js
import { showNativeDialog } from "../extensions/dialog.js";
```

子代理请求权限时不再弹原生 TUI 提示，而是走 Picot 的 native dialog（来自 `picot-bridge` 的 `showNativeDialog` RPC）。

#### 1.4 子代理结束后结果可以一键 Send 回 Pi

```js
onSendResult: (settled) => {
  settled.resultSent = true;
  persist(settled);
  sendToPi(buildResultPrompt(settled));
},
```

`buildResultPrompt` 把子代理结果包装成：

```text
Result from the Claude Code subagent for the task:

> Fix the failing test

---

<result text from subagent>
```

然后注入 Pi 的 composer。这跟 Pi 直接调用 Claude Code 的体感完全一致，只是 Pi session 不用切换 backend。

#### 1.5 子代理运行持久化

每次 start / update / 完成都写入本地（`subagent-store.js`），下次进入同一个 session 时会 `restore()`，卡片重新展示，类似 Pi session 自身持久化。这意味着：

- 用户切换 session 回来，子代理记录还在
- 重启 Picot，之前的子代理结果在主消息列表里可重新查看
- "Send to Pi" 按钮在未发送状态下恢复时仍可点击

#### 1.6 多轮 follow-up

```js
async function sendFollowUp(run, text) {
  await runtime.request({ type: "acp_prompt", message: text }, ...);
}
```

子代理 session 是**常驻的**（不是一次性 spawn）：第一轮 prompt 后 ACP runtime 继续存活，用户可在卡片内继续发送 follow-up，复用同一个 ACP session。只有显式 `endRun()` 或 workspace/app teardown 时才 `acp_task_stop`。

### 架构变化（用户看不见的部分）

#### Rust 新增 ACP task runtime

```text
src-tauri/src/acp_launch.rs         +285 行
src-tauri/src/acp_manager.rs        +36 行
```

`acp_launch.rs` 启动一个 ACP 子进程作为子代理 runtime（区别于 `native_pi_manager` 启动 pi）；`acp_manager.rs` 维护 Pi session 与 ACP task runtime 的并存关系。`host_server.rs` 增加路由：

- `acp_task_start` —— 启动 ACP 子代理
- `acp_task_stop` —— 关闭
- `acp_list_agents` —— 列出本地可用的 ACP 客户端

#### 前端 store 与 message-renderer 解耦

`subagent-store.js`（新建）和 `acp-store.js`（扩展）共同维护：

- `runsByInstance: Map<instanceId, run>`
- 每个 run 持有自己的 state machine（pending/running/done/error）

`subagent-card.js` 是一个独立的 view 层，订阅 store 变化重渲染自身，但**不写入 `#messages` DOM 树之外** —— 它和 Pi 的 user/assistant turn 共用同一条消息流。

#### Sanitize markup 抽到独立文件

```text
public/ui/sanitize-markup.js       +48 行
```

把 `_sanitizeMarkup` 从 `message-renderer.js` 抽出独立模块，因为子代理卡片渲染 ACP 的 streaming content 也要走相同的 HTML sanitizer（防御 Markdown 注入）。这是 commit message 里 "reuse shared Markdown, tool cards" 的安全前提。

### 与 SSH / 远程工作区的关系

**不直接相关**。这个 commit 只涉及 ACP subagent（外部 Agent Client Protocol agents，比如 Claude Code / Codex / Cursor 等），跟 SSH 工作区是不同的概念。SSH 工作区是 `5d8e0ed` / `726ea33` / `0a4a367` 等几个 commit。ACP 是本地子进程，SSH 是远端会话。

### 测试覆盖

- `public/native/acp/subagent-card.test.js` —— 卡片渲染、状态切换、expand/collapse
- `public/native/acp/subagent-runs.test.js` —— 生命周期、follow-up、endRun
- `public/native/acp/subagent-store.test.js` —— 持久化 round-trip
- `public/native/acp/acp-store.test.js` —— state machine reduce
- `public/native/composer/composer-agent-menu.test.js` —— `#` 触发替换逻辑

`bun run test` 总计 1517 个测试通过，包括这些。

### 已知限制

1. 依赖本地安装 ACP CLI（Claude Code / Codex 等），未安装时 `acp_list_agents` 返回空列表。
2. 子代理运行过程中的网络异常通过 `acp_error` 事件反映，但不支持断线重连。
3. 子代理 stdout/stderr 不在卡片内显示，仅工具调用结果与状态可见。

---

## 2. 会话导航点击代理

Commit：`30364384c1b89971ee5f44a811ec8fe4595e5752` — *feat: enable click delegation on conversation navigator rail for improved user interaction*

### 一句话

UX 微改进：让 conv-nav 轨道（聊天右边的圆点导航条）整个可点击而不只是圆点本身。点击间隙或轨道内边距区域也会跳到"视觉上最近"的那一轮。

### 用户能看见的变化

#### 之前

```text
│ ● ● ● ● ● ● │   ← 只有圆点本体可点击
```

点击圆点之间的间隙或轨道内边距区域**不会跳转**，用户必须精确击中细小的圆点。

#### 现在

```text
│ ● ● ● ● ● ● │   ← 整个轨道 + 间隙都接受点击
│ ↑ 在任何位置点击都跳到最近的那一轮
```

### 实现：click delegation

```js
this._onNavClick = (e) => {
  // 圆点自身仍然接受 click（mouse click + keyboard activation）
  if (e.target?.closest?.(".conv-nav-dot")) return;
  // 点击落在间隙或 padding 内 → 按最近 turn 索引跳转
  const idx = this.#indexFromClientY(e.clientY);
  if (idx < 0) return;
  const turn = this.#turns[idx];
  if (!turn) return;
  this.#jumpTo(turn, idx);
};

this.#navEl.addEventListener("click", this._onNavClick);
```

三个细节：

1. **排除圆点**：先 `closest('.conv-nav-dot')` 排除，否则会和圆点自身的 click handler 双重触发。
2. **复用 hover 的索引算法**：`#indexFromClientY` 之前只用于 hover 显示 tooltip，现在 click 也用它，所以点击的"最近 turn"语义和 hover 完全一致 —— 用户在哪条 tooltip 上悬停过再点击，结果就是同一条。
3. **destroy 时清掉 listener**：

```js
this.#navEl?.removeEventListener("click", this._onNavClick);
```

### 测试覆盖

新增 1 个 vitest case：

```js
it("jumps to the nearest turn when a click lands in the inter-tick gap", () => {
  ...
  // clientY 141 sits in the gap between dot 1 (ends 132) and dot 2
  // (starts 148), nearer to dot 2 (mid 152). The whole-rail delegation
  // must still jump to turn index 2 instead of doing nothing.
  track.dispatchEvent(new MouseEvent("click", { clientY: 141, bubbles: true }));
  expect(messages.scrollTop).toBe(220);
});
```

### 用户感知

- 之前：用户得小心地对准圆点。
- 之后：在轨道上任何位置点击都行，且总是跳到"视觉上最近"的那一轮。
- 键盘激活（Tab + Enter）和圆点自身的 click 行为都不变。

### 已知限制

无。改动向后兼容：圆点自身的 click handler 仍可用。

### 与其他功能的关系

纯 UI 改进，与 ACP subagent cards、子进程孤儿清理完全独立。

---

## 3. 子进程孤儿清理

模块：`src-tauri/src/child_supervision.rs`（新增）+ 多处调用点修改

### 一句话

每次启动一个 `pi` 子进程，Picot 给它打 3 道保险：

1. 把子进程变成进程组 leader（Unix）/ job object（Windows）以保证能一次性杀掉它和它派生的所有孙进程；
2. 把 pid 写到 `~/.pi/picot-runtimes/<我的 pid>.json` 注册表里；
3. 启动 Picot 时先扫一次注册表，kill 任何"前一个 Picot 死了但 pi 还活着"的孤儿子进程。

### 三个独立的失效场景

子进程孤儿清理不是单一功能，是为了**解决三个各自独立又会同时发生**的故障模式：

#### 场景 1：Pi runtime 自己卡死

子进程的正常退出路径是 Picot 关闭 stdin → pi 读到 EOF 退出。但**卡死的 pi 不会读 stdin**，所以不会看到 EOF，自然不退出。如果 Picot 又被 SIGKILL，这种孤儿会永远留在系统里。issue 复现：曾经有一个孤儿 pi 进程在 Picot 消失 9 天后还在 100% CPU 跑。

#### 场景 2：只杀直接子进程，孙进程还活着

`pi` 自己会派生 worker / subagent runtime（subagent-card 用到的 ACP 子进程）。只 kill `pi` 还不够，subagent 仍能继续跑。所以必须把整个进程树作为一个单元杀掉。

#### 场景 3：Picot 自己被 SIGKILL，没有机会跑 teardown

如果 Picot 自身崩了或被强杀，上面的"kill 子进程"逻辑永远没机会跑。所以需要**持久化注册表**记录哪些子进程是我生的，下一次 Picot 启动时去收拾。

### 实现：三个机制协同

#### 机制 A：进程组 / Job Object

```rust
pub fn make_group_leader(command: &mut Command) {
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            if libc::setpgid(0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    ...
}
```

`native_pi_manager::spawn` 在 `command.spawn()` 之前调用 `make_group_leader`：

```rust
crate::child_supervision::make_group_leader(&mut command);
let child = command.spawn()
    .map_err(|error| format!("Cannot start embedded Pi native RPC process: {error}"))?;
crate::child_supervision::record_runtime(child.id());
```

这样 `pi` 启动后立即成为自己进程组的 leader，`setpgid(0,0)` 把 child pid 作为 group id。后续无论 `pi` 再派生什么子进程（subagent / worker），都自然落在这个 group 下，kill 时 `killpg(-pid, SIGTERM)` 就能整棵树清理。

Windows 用 Job Object：

```rust
pub struct JobHandle(HANDLE);

pub fn create_and_assign(pid: u32) -> Option<JobHandle> {
    unsafe {
        let job = CreateJobObjectW(...);
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(...);
        let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        AssignProcessToJobObject(job, process);
        ...
        Some(JobHandle(job))
    }
}
```

`KILL_ON_JOB_CLOSE` 是关键：当 Picot 退出时它持有的 handle 全部关闭，Windows 看到 job 没人持有就把整个 job 杀掉。这是在 Windows 上不需要任何 teardown 代码就能清理孙进程的机制。

`PiRpcBridge::attach` 在创建 `PiRpcProcess` 时把 child pid 包进 `ChildTree::attach`：

```rust
pub fn attach(pid: u32) -> Self {
    Self {
        pid,
        #[cfg(windows)]
        job: windows_job::create_and_assign(pid),
    }
}

pub fn terminate(&mut self) {
    #[cfg(unix)] {
        let group = -(self.pid as i32);
        unsafe { libc::kill(group, libc::SIGTERM); }
        for _ in 0..20 {
            if !pid_is_alive(self.pid) { return; }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        unsafe {
            libc::kill(group, libc::SIGKILL);
            libc::kill(self.pid as i32, libc::SIGKILL);
        }
    }
    #[cfg(windows)] {
        if let Some(job) = self.job.take() { windows_job::terminate(job); }
    }
}
```

正常关闭路径：SIGTERM → 等 500ms → 还活着就 SIGKILL。

#### 机制 B：注册表

```rust
fn registry_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".pi").join(REGISTRY_DIR))
}

fn registry_path_for(supervisor_pid: u32) -> Option<PathBuf> {
    registry_dir().map(|dir| dir.join(format!("{supervisor_pid}.json")))
}
```

注册表位置 `~/.pi/picot-runtimes/<我的 pid>.json`，文件名用 Picot 自己的 pid，多个 Picot 实例不互相覆盖。

```json
{
  "supervisor_pid": 12345,
  "entries": [
    { "pid": 67890, "started_at": "Thu Sep  3 11:59:30 2026" }
  ]
}
```

- `supervisor_pid`：生成这个注册表的 Picot 进程 pid
- `entries`：每个 spawn 的 pi 子进程，记录 pid + 启动时间

**为什么记录 `started_at`？** 关键。看这个 test case：

```rust
#[test]
fn never_kills_a_pid_that_was_recycled() {
    registry_with(&dir, 4242, vec![RuntimeEntry {
        pid: 7001,
        started_at: "Thu Sep  3 11:59:30 2026".into(),
    }]);
    let count = sweep_orphans_in(Some(dir.clone()), 1, &|pid| pid == 7001, &|pid| {
        killed.borrow_mut().push(pid)
    });
    assert_eq!(count, 0);
}
```

PID 在 Linux 上是顺序分配的，系统重启或 pid wrap 后，pid 7001 可能被**任何**进程重新占用。如果只比对 pid，可能误杀无辜进程。所以同时校验进程启动时间（`ps -o lstart=`），不一致就跳过。

启动时间写入：

```rust
pub fn process_start_time(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output().ok()?;
    ...
}
```

清理：

```rust
pub fn record_runtime(pid: u32) { ... registry.entries.push(...) ... write_registry(...) }
pub fn forget_runtime(pid: u32) {
    let Some(mut registry) = read_registry(&path) else { return; };
    registry.entries.retain(|entry| entry.pid != pid);
    if registry.entries.is_empty() {
        let _ = std::fs::remove_file(&path);
    } else {
        write_registry(&path, &registry);
    }
}
```

`forget_runtime` 在子进程正常退出（runtime 停止）时调用，registry 最后一个 entry 走了就连文件一起删，避免下一次启动时还看到空文件。

#### 机制 C：启动时扫描

```rust
fn main() {
    ...
    // Runtimes left behind by a Picot that was killed outright: no teardown of
    // ours ran for those, so this is the only chance to collect them.
    let swept = child_supervision::sweep_orphans();
    if swept > 0 {
        log::info!("[picot-native] cleaned up {swept} orphaned pi runtime(s) from a previous run");
    }
    ...
}
```

`main` 在任何 Tauri 业务逻辑启动之前就调用一次 `sweep_orphans()`：

```rust
pub fn sweep_orphans() -> usize {
    sweep_orphans_in(registry_dir(), std::process::id(), &pid_is_alive, &|pid| {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
            libc::kill(pid as i32, libc::SIGKILL);
        }
        ...
    })
}

fn sweep_orphans_in(dir, self_pid, alive, kill) -> usize {
    for item in fs::read_dir(&dir).flatten() {
        let path = item.path();
        ...
        let Some(registry) = read_registry(&path) else { fs::remove_file(&path); continue; };
        // 跳过自己的注册表
        if registry.supervisor_pid == self_pid || alive(registry.supervisor_pid) { continue; }
        for entry in &registry.entries {
            if !alive(entry.pid) { continue; }
            // 跳过 pid 被回收的
            let current = process_start_time(entry.pid).unwrap_or_default();
            if !entry.started_at.is_empty() && current != entry.started_at { continue; }
            kill(entry.pid);
            killed += 1;
        }
        let _ = fs::remove_file(&path); // 无论是否杀都清掉注册表
    }
    killed
}
```

四个守卫：

1. **跳过自己的注册表**：`supervisor_pid == self_pid` 直接跳过（双重启动不会自残）
2. **跳过 supervisor 还活着的**：另一个 Picot 进程仍然持有这些子进程，不能越权杀
3. **跳过已死子进程**：注册表过期但 pid 已经被回收成无关进程
4. **跳过 pid 被 wrap 的**：用 `lstart` 对比

正常 Picot 退出时还有一步 `clear_registry()`：

```rust
.run(|app_handle: &tauri::AppHandle, event| {
    if let tauri::RunEvent::Ready = event {
        install_termination_handlers(app_handle.clone());
    }
    if let tauri::RunEvent::Exit = event {
        if let Some(manager) = app_handle.try_state::<NativePiManagerState>() {
            manager.stop_all();
        }
        child_supervision::clear_registry();
    }
});
```

Picot 正常退出时清理自己的注册表，下次启动就不用扫描这一份了。

### 测试覆盖

```text
kills_runtimes_whose_supervisor_is_gone       OK
leaves_runtimes_of_a_live_supervisor_alone    OK
never_kills_a_pid_that_was_recycled           OK
ignores_our_own_registry_file                 OK
a_live_process_reads_as_alive                 OK
```

`child_supervision` 把 OS 依赖（`pid_is_alive`, `kill`）抽出接受闭包参数，这样测试可以纯函数化验证四个守卫的逻辑而不用真起子进程。

### 用户能不能感受到

普通正常关闭：感受不到，因为 `clear_registry` 已经清掉了。

Picot 崩溃或被 SIGKILL：下次启动时控制台会打印一行：

```text
[INFO] picot-native: cleaned up 3 orphaned pi runtime(s) from a previous run
```

非零时日志可见。等于 0 时静默。

长时间不关机 + 频繁 crash 的开发机器上：这项功能避免了"系统里堆积 pi 进程"的问题。过去复现过 chat channel 被孤儿 pi 锁住导致新 session 起不来的故障，现在不会再出现。

### 与 windows_child / appimage_env 的关系

容易被搞混。三个机制相互独立又互补：

| 机制 | 关注点 | 触发时机 |
| --- | --- | --- |
| `child_supervision` | 子进程树生命周期 | spawn 时建立 leader，正常退出 clear，崩溃后下次启动 sweep |
| `windows_child` | 子进程 console 窗口可见性 | spawn 时设置 `CREATE_NO_WINDOW` |
| `appimage_env` | AppImage 内环境变量污染子进程 | spawn 时清掉 `LD_LIBRARY_PATH` 等 |

三项都是 `native_pi_manager::spawn` 前后插入的轻量 hook，确保 `pi` 子进程不会因为 Picot 宿主环境出意外。

### 已知限制

1. 仅 Unix / Windows 双平台支持，理论上 Linux 上 ps / killpg 行为稳定，macOS 上需要保证 `/usr/bin/ps` 可用。
2. `process_start_time` 依赖系统 `ps` 命令，未安装或 PATH 缺失时返回空字符串，guard 4 退化为"放过该 entry"，最坏情况是留下孤儿。
3. 注册表文件位于用户 home 下，`~/.pi/` 被权限锁定时整个机制静默失效。
