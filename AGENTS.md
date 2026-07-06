## graphify

This project has a graphify knowledge graph at graphify-out/.

Rules:
- Use graphify when it is necessary or clearly helpful for the task, especially for architecture, codebase orientation, or cross-module relationship questions.
- If graphify-out/wiki/index.md exists and the task benefits from graph context, navigate it before reading raw files.
- For cross-module "how does X relate to Y" questions, consider `graphify query "<question>"`, `graphify path "<A>" "<B>"`, or `graphify explain "<concept>"` over grep — these traverse the graph's EXTRACTED + INFERRED edges instead of scanning files.
- After substantial code changes, update graphify when it is appropriate and useful for keeping the knowledge graph current.

## Git workflow

- After completing any change, run appropriate verification first and make sure the result is correct with no known bugs or regressions. Then commit and `git push` to origin automatically — no need to ask for confirmation.
