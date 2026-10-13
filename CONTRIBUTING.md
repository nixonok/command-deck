# Contributing to Command Deck

Thanks for helping. Bug reports, ideas, corrections and pull requests are all welcome. You do not need to ask first.

## Open an issue

Use the issue templates: [bug report](https://github.com/nixonok/command-deck/issues/new?template=bug_report.md) or [feature request](https://github.com/nixonok/command-deck/issues/new?template=feature_request.md).

- Search open and closed issues first.
- For a bug, give your Claude Code version, the steps, what you expected and what happened.
- Do not paste secrets, tokens, full file paths from your machine or private project text. Cut them out.

## Send a change

1. Fork the repo and create a branch from `main`, for example `fix-board-crash`.
2. Keep the change small and about one thing. Do not mix refactors with fixes.
3. Edit the source (see "Edit the mod" in the [README](README.md)).
4. Run both checks. Both must pass:
   ```bash
   claude plugin test .
   claude plugin validate . --strict
   ```
5. Add or update a test in `hooks/deck.test.ts` for new behavior or a fixed bug.
6. Update the README if a command, setting or behavior changed.
7. Commit with a clear message, push your branch and open a pull request against `main`. Fill in the pull request template.

## What a good change looks like

- Fixes the cause, not the symptom.
- Matches the style of the code around it.
- Adds no new dependency without a strong reason.
- Adds no personal data: no names, emails, paths, keys or machine names.
- Leaves unrelated code alone.

## Versions

Do not bump the version in your pull request. The maintainer sets it at release time (`.claude-plugin/plugin.json`, semantic versioning).

## Review

Every pull request is read by the maintainer before it is merged. Expect questions and requests for changes; they are about the code, not about you. Pull requests that fail the two checks are not merged.

## Conduct

Be kind and be specific. Disagree with ideas, not people.

## License

By contributing you agree your work is released under the [MIT License](LICENSE).
