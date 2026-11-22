# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/muliadiaz-hue/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/muliadiaz-hue/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a command-line tool that applies AI-written edits in four formats — unified diff, SEARCH/REPLACE blocks, V4A patches, and JSON edits — to a tree of text files, all-or-nothing, exactly as SPEC.md says. It finds the lines an edit names even when the model drifted their whitespace or indentation, using SPEC's three-tier matching. Node 22, standard library only.

## Run it

```sh
node main.ts [options] [PATCH]
```

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: in a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did.
- `check.ts`: the practice set on your own machine, from the kit's `program/generator/practice.json`.
- `SPEC.md`: the whole specification.
- `LICENSE`: MIT.

---

<sub>Entered on [make.fun](https://make.fun/?ref=c81nkrnx&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
