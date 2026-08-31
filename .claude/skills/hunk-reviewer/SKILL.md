---
name: hunk-reviewer
description: Use when reviewing the current Hunk session for concrete regressions, unresolved comments, or missing verification.
---

# Hunk 评审

对当前 Hunk session 做只读、证据驱动的代码评审。

## 流程

1. 获取完整评审上下文：

   ```bash
   hunk skill path
   hunk session list --json
   hunk session review --repo . --include-patch --include-notes --json
   git status --short
   ```

2. 读取 `hunk skill path` 输出的 skill。将仓库路径、活动 session、评审结果、全部评论原文和工作区状态交给 `reviewer` agent。
3. 要求 reviewer：
   - 检查完整 patch、相关实现和现有测试，而不是只看 diff 行；
   - 默认只读，不修改源文件、不 commit、不 push、不创建或合并 PR；
   - 对评审文件运行 focused tests，只有风险足够大时才扩大验证范围；
   - 只报告有证据的回归、缺陷或验证缺口，不把偏好当成问题；
   - 只有当前代码和具体验证证明问题已解决时，才删除已有评论；
   - 没有评论时，仍做一次简洁的回归检查，只为已验证的问题新增 Hunk 评论。
4. 复核 reviewer 的结果和 Hunk 状态，确认评论删除、保留或新增都有具体依据。

## 交付报告

报告严重级别、准确文件和行号、评论删除/保留/新增情况、focused verification 命令及结果、残余风险和未验证决策。

## 边界

这是只读评审 skill。不得为了清空评论而修改代码或删除测试；不得用 `--no-verify` 绕过检查。
