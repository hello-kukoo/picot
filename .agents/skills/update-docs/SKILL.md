---
name: update-docs
description: Use when implementation changes may require synchronized updates to Picot design specs, architecture guidance, agent instructions, or bilingual README documentation.
---

# 同步项目文档

根据已经完成且可核对的实现变更，更新实际受影响的设计、架构、指南和 README 文档；不要用文档掩盖实现偏差。

## 流程

1. 先检查：

   ```bash
   git status --short
   git diff --stat
   git diff
   ```

   保护所有用户未提交的工作。额外用户要求作为上下文，但不能替代代码和测试证据。
2. 阅读当前实现、配置、测试和相关文档，确定实际影响范围。重点检查：
   - `docs/superpowers/specs/` 对应设计 spec；
   - `ARCHITECTURE.md`；
   - `AGENTS.md`；
   - `README.md` 和 `README.zh.md`。
3. 逐项将文档描述与代码、配置、测试和运行流程对照。只修改有证据表明已过时或不完整的文件；没有影响证据时不要为了“完整性”修改。
4. 保持每份文档原有语言、结构、术语和 Markdown 风格。中英文 README 涉及同一行为时同步等价信息。
5. 如果实现与 design spec 冲突，不要静默改写历史设计决策。报告冲突；只有在实现确实定义了当前行为时，才更新 spec 的实现偏差或等价章节。
6. 核对文档链接、路径、命令、版本号和示例。不要新增未经运行或验证的命令和承诺。
7. 完成后检查 diff，确认没有覆盖无关改动，并运行适用的文档验证；若没有适用命令，明确说明。

## 交付报告

列出每个修改文件及其与实现对应的原因；列出已检查但无需更新的文档；报告运行的验证命令和结果，以及仍存在的实现与文档不一致。

## 边界

本 skill 只同步有证据支持的文档，不负责实现功能、不修改历史决策来掩盖 bug，也不自动 commit、push 或创建 PR。
