# Worktree Collaboration

When working in a worktree, the main agent acts as the orchestrator. It owns
scope, sequencing, branch hygiene, and the final call on whether the work is
ready. Subagents are workers: use them for focused implementation, review, or
research tasks, then fold their output back into one coherent branch.

Keep each worktree tied to its branch. When the work is done, push that branch
and open a PR for it. Do not leave finished work only in the local worktree.

For large end-to-end features, prefer stacked PRs over one oversized PR. Each
PR should be reviewable on its own and should explain what depends on what.

Do not default every PR to draft. Use draft when the developer asks for draft
or when the branch is intentionally unfinished. When the agent is done and
wants review, open the PR as ready for review so the developer is notified.

After opening a PR, start a short-lived follow-up task when useful. A good
default is checking every 30 minutes for one day for human review or code
review bot feedback. The task should stop early when feedback is found: report
the review back in the thread, then delete or pause the automation. The
bounded schedule is the fallback cleanup if early deletion is unavailable.
