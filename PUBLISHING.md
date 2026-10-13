# Publishing Command Deck

## 0. Before every release

```bash
claude plugin test .
claude plugin validate . --strict
```

Bump the version in `.claude-plugin/plugin.json` (semver: patch for fixes, minor for features, major for breaking changes). Users only get an update when it changes.

```bash
git add -A && git commit -m "Release 1.0.1" && git tag v1.0.1 && git push && git push --tags
```

## 1. Your own marketplace (works today, nothing to approve)

This repo is already a marketplace: `.claude-plugin/marketplace.json` lists the plugin from `./`.

Share this with anyone:

```
/plugin marketplace add nixonok/command-deck
/plugin install command-deck@command-deck-market
```

Users update with `/plugin marketplace update command-deck-market`, or turn on auto-update in `/plugin` → Marketplaces.

## 2. Anthropic's plugin directory (claude.ai/directory)

1. Needs a paid claude.ai plan.
2. Run `claude plugin validate . --strict`.
3. Read the checklist: https://claude.com/docs/plugins/pre-submission-checklist
4. Submit at https://claude.ai/directory/manage and follow https://claude.com/docs/plugins/submit
5. Optional listing fields in `plugin.json`: `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`. Add a support URL (your GitHub issues page) and a privacy note before submitting.

The `claude-plugins-official` marketplace does not take portal submissions.

## Name rules

Plugin names starting with `claude-`, `anthropic-` or `anthropics-` fail validation. `command-deck` is fine.
