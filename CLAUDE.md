## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- ALWAYS read graphify-out/GRAPH_REPORT.md before reading any source files, running grep/glob searches, or answering codebase questions. The graph is your primary map of the codebase.
- IF graphify-out/wiki/index.md EXISTS, navigate it instead of reading raw files
- For cross-module "how does X relate to Y" questions, prefer `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep - these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## git / push

When the user asks to push changes:
- Inspect `git status -sb` and the relevant diff before staging.
- Do not stage unrelated user changes silently; if the scope is mixed or unclear, ask first.
- Run the relevant checks for the changed surface before committing.
- Commit with a short, descriptive message, then push the current branch with upstream tracking.
- If a PR is expected but GitHub tooling is unavailable, still push the branch and report the PR blocker clearly.
