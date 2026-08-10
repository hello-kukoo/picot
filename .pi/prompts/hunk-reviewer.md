---
description: Load the Hunk skill and use it for this review
---

Run `hunk skill path` to get the skill path. Give the skill path to a `reviewer` subagent and let it review the current Hunk session.

Prepare the reviewer task with:

- The full output of `hunk skill path`.
- The current repository path and the live Hunk session id (or `--repo .` if there is only one session).
- The output of `hunk session list --json` and `hunk session review --repo <repo> --json` (or `--include-patch --include-notes --json` for full context).
- The full text of every existing Hunk comment.
- The current `git status --short` so unrelated uncommitted work is visible.

Scope for the reviewer:

- Read-only by default; do not modify source files, do not commit, and do not open or merge PRs.
- Inspect the patch and existing tests, not just the diff lines.
- Do not run the full test suite by default. Run focused tests for the reviewed files and widen verification only when the change scope or risk requires it, then report the reason.

Comment cleanup:

- An existing comment may be removed with `hunk session comment rm --repo <repo> <comment-id>` only when the issue is demonstrably fixed by the current code and verification. Code, focused tests, or other concrete evidence must support the removal.
- Do not remove comments based only on an intended design or an implementation claim that the reviewer cannot verify.
- Retain unresolved or partially addressed comments in place and explain why in the reviewer report.

When no comments remain, perform a concise review for concrete regressions and add a Hunk comment only for a verified issue.

Report: severity, exact file/line references, comments removed/retained/added, focused verification commands and results, and any residual risks or unverified decisions.
