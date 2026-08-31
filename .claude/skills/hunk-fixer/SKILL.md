---
name: hunk-fixer
description: Use when resolving actionable comments from an active Hunk review session and the fixes require repository changes with focused verification.
---

# Hunk 评论修复

处理当前 Hunk session 中的所有未解决评论，并把每条评论落实为可验证的代码修复。

## 流程

1. 获取上下文：

   ```bash
   hunk skill path
   hunk session list --json
   hunk session review --repo . --include-patch --include-notes --json
   git status --short
   ```

2. 读取 `hunk skill path` 输出的 skill，并把当前仓库路径、活动 session、全部评论原文和工作区状态交给 `worker` agent。
3. 要求 worker：
   - 把每条评论视为未解决问题，逐条验证；
   - 只修改解决评论所需的文件；
   - 保护无关的未提交改动；
   - 不 commit、push、创建或合并 PR；
   - 对修改文件运行 focused tests，只有风险足够大时才扩大验证范围；
   - 评论需要产品、架构或范围决策时停止并向上级询问。
4. worker 完成后重新运行：

   ```bash
   hunk session review --repo . --include-patch --include-notes --json
   ```

5. 确认评论文本对应的代码和验证结果。只有问题已被当前代码和具体验证证明解决时，才允许删除评论；未解决或部分解决的评论必须保留并说明原因。

## 交付报告

报告以下内容：评论 ID 和处理结果、修改文件、focused verification 命令及结果、保留的评论及原因、剩余风险。

## 边界

本 skill 会修改代码，但不负责提交或发布。不得用 `--no-verify` 绕过检查，不得为了变绿而删除或削弱测试。
