---
description: Load the Hunk skill, get its inline comments, and fix the issue per those comments
---

Run `hunk skill path` to get the skill path. Give the skill path to a `worker` subagent and let it fix the issues raised by the Hunk inline comments.

Prepare the worker task with:

- The full output of `hunk skill path`.
- The current repository path and the live Hunk session id (or `--repo .` if there is only one session).
- The output of `hunk session list --json` and `hunk session review --repo <repo> --json` (or `--include-patch --include-notes --json` for full context) so the worker can see every existing comment.
- The full text of every existing Hunk comment to act on.
- The current `git status --short` so unrelated uncommitted work is visible.

Scope for the worker:

- Treat every comment as an unresolved issue until verified; only modify files needed to address these comments.
- Do not touch unrelated uncommitted work, do not commit, do not push, and do not open or merge PRs.
- Stop and ask through the parent if a comment requires a product, architecture, or scope decision beyond what the comment describes.
- Run focused tests for the changed files. Do not run the full suite by default; widen verification only when the change scope or risk requires it, and report the reason.

After fixing:

- Re-run `hunk session review --repo <repo> --include-patch --include-notes --json` and confirm the comment text reflects the fix.
- Leave unresolved comments in place and explain why in the worker report.
- Report: comment ids handled, files changed, focused verification commands and results, and any comments intentionally retained.
