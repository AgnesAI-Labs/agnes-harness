import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { hardBlockedCommand } from '../src/command-table/hard-block.js'
import {
  OUTWARD_COMMAND_RULES,
  OUTWARD_KNOWN_GAPS,
  OUTWARD_NESTING,
  outwardCommand,
} from '../src/command-table/outward.js'

const nested = (depth: number, inner: string): string =>
  depth === 0 ? inner : `bash -c ${JSON.stringify(nested(depth - 1, inner))}`

describe('outwardCommand', () => {
  it.each(OUTWARD_COMMAND_RULES.flatMap((rule) => rule.match.map((sample) => [rule.id, sample] as const)))(
    '%s holds %j',
    (id, sample) => {
      expect(outwardCommand(sample)).toBe(id)
    },
  )

  it.each(OUTWARD_COMMAND_RULES.flatMap((rule) => rule.notMatch.map((sample) => [rule.id, sample] as const)))(
    '%s lets %j through',
    (_id, sample) => {
      expect(outwardCommand(sample)).toBeUndefined()
    },
  )

  it.each(OUTWARD_NESTING.match)('counts nesting it does not read as a hit: %j', (sample) => {
    expect(outwardCommand(sample)).toBe(OUTWARD_NESTING.id)
  })

  it('reads three levels of shell payload and stops after that', () => {
    expect(outwardCommand(nested(3, 'git push'))).toBe('git-push')
    expect(outwardCommand(nested(3, 'ls'))).toBeUndefined()
    expect(outwardCommand(nested(4, 'ls'))).toBe(OUTWARD_NESTING.id)
  })

  /**
   * Every input from the independent review of the first implementation, with what the rules say
   * now. Rows that expect `undefined` were false hits.
   */
  it.each([
    // An alias makes any word run push.
    ['git -c alias.p=push p', 'git-push'],
    ["git -c 'alias.x=!git push' x", 'git-push'],
    ['git config alias.ship push && git ship', 'git-push'],
    // Shell builtins and options that run their arguments.
    ['eval git push', 'git-push'],
    ["eval 'git push'", 'git-push'],
    ["env -S 'git push'", 'git-push'],
    ["env --split-string='git push'", 'git-push'],
    ["bash -c -- 'git push'", 'git-push'],
    // Other shells.
    ["fish -c 'git push'", 'git-push'],
    ["pwsh -c 'git push'", 'git-push'],
    ['cmd /c git push', 'git-push'],
    ["busybox sh -c 'git push'", 'git-push'],
    // Wrappers and launchers.
    ['find . -exec git push \\;', 'git-push'],
    ['watch -n 1 git push', 'git-push'],
    ['parallel git push ::: origin', 'git-push'],
    ["script -qc 'git push' /dev/null", 'git-push'],
    ["su -c 'git push' me", 'git-push'],
    ['setsid git push', 'git-push'],
    ['stdbuf -oL git push', 'git-push'],
    ['flock /tmp/l git push', 'git-push'],
    ['xcrun git push', 'git-push'],
    ['uv run git push', 'git-push'],
    ['poetry run git push', 'git-push'],
    ['bundle exec git push', 'git-push'],
    ['npm exec -- git push', 'git-push'],
    ['npm x git push', 'git-push'],
    ['direnv exec . git push', 'git-push'],
    ['op run -- git push', 'git-push'],
    ['time sudo git push', 'git-push'],
    ["time bash -c 'git push'", 'git-push'],
    // git running a command of its own.
    ["git submodule foreach 'git push'", 'git-push'],
    ["git rebase --exec 'git push' HEAD~1", 'git-push'],
    // Nesting deeper than the rules read.
    [nested(4, 'git push'), OUTWARD_NESTING.id],
    // Rule-category gaps.
    ['docker buildx build --push .', 'package-publish'],
    ['npm dist-tags add x@1 next', 'package-publish'],
    ['npm access set status=public', 'package-publish'],
    ['uv publish', 'package-publish'],
    ['poetry publish', 'package-publish'],
    ["gh api -H 'X-HTTP-Method-Override: DELETE' repos/o/r", 'gh-write'],
    ['curl -K cfg https://example.test/x', 'http-write'],
    ['git subtree push --prefix d origin main', 'git-push'],
    ['git lfs push origin main', 'git-push'],
    ['git-push origin', 'git-push'],
    ['npm pub', 'package-publish'],
    ['curl -X GET -X POST https://example.test/x', 'http-write'],
    ['gh api -X GET -X POST repos/o/r/issues', 'gh-write'],
    // False hits the review measured that are no longer hits.
    ['curl -X POST localhost:3000/api', undefined],
    ['curl -d a=1 http://127.0.0.1:8080/x', undefined],
    ['ssh -V', undefined],
    ['scp a b', undefined],
    ['npm test -- --grep publish', undefined],
    ['cargo run --bin publish', undefined],
    ['cargo test owner', undefined],
    ['docker logs push', undefined],
    ['git push --dry-run', undefined],
    ['npm publish --dry-run', undefined],
    // False hits the review measured that stay hits: each reaches a remote or changes account state.
    ['curl -d a=1 https://example.test/x', 'http-write'],
    ['ssh -T git@github.com', 'remote-shell'],
    ["gh api graphql -f query='query{viewer{login}}'", 'gh-write'],
    ['gh auth login', 'gh-write'],
    ['gh repo set-default o/r', 'gh-write'],
    // Second review: a dry-run word that may be another option's value, or a verb without a dry run.
    ['git push -o --dry-run origin main', 'git-push'],
    ['rsync --log-file --dry-run ./x host:/y', 'remote-shell'],
    ['rsync --out-format -n ./x host:/y', 'remote-shell'],
    ['npm owner add u pkg --dry-run', 'package-publish'],
    ['npm dist-tag add x@1 latest --dry-run', 'package-publish'],
    ['npm access set status=public --dry-run', 'package-publish'],
    ['npm unpublish x --dry-run', 'package-publish'],
    ['npm publish --access public --dry-run', undefined],
    ['rsync -av --dry-run ./a host:/b', undefined],
    // Second review: keywords, `!`, builtins and redirections before the command.
    ['if true; then git push; fi', 'git-push'],
    ['for x in 1; do git push; done', 'git-push'],
    ['while :; do git push; done', 'git-push'],
    ['if false; then :; else git push; fi', 'git-push'],
    ['! git push', 'git-push'],
    ['{ git push; }', 'git-push'],
    ['(git push)', 'git-push'],
    ['case x in a) git push;; esac', 'git-push'],
    ['builtin command git push', 'git-push'],
    ['if true; then exec git push; fi', 'git-push'],
    ['>/dev/null git push', 'git-push'],
    ['> out git push', 'git-push'],
    ['2>&1 git push', 'git-push'],
    ['if true; then echo push; fi', undefined],
    // Second review: a global option the lists do not know, taking the next word as its value.
    ['git --attr-source HEAD push', 'git-push'],
    ['npm --tag beta publish', 'package-publish'],
    ['npm --access public publish', 'package-publish'],
    ['npm --loglevel warn publish', 'package-publish'],
    ['cargo --config x=1 publish', 'package-publish'],
    ['cargo -Z unstable publish', 'package-publish'],
    ['cargo --color always publish', 'package-publish'],
    ['cargo --manifest-path a/Cargo.toml publish', 'package-publish'],
    ['docker --tlscacert ca push org/i', 'package-publish'],
    ['docker --tlscert c push org/i', 'package-publish'],
    ['docker --tlskey k push org/i', 'package-publish'],
    ['git --no-pager log --grep push', undefined],
    ['cargo --manifest-path a/Cargo.toml run --bin publish', undefined],
    ['npm --silent run publish', undefined],
    ['docker --tlscacert ca pull x', undefined],
    // Second review: gh reads are listed per command group; other groups and actions ask.
    ['gh label clone o/r', 'gh-write'],
    ['gh codespace create', 'gh-write'],
    ['gh cache delete 1', 'gh-write'],
    ['gh secret set X', 'gh-write'],
    ['gh variable set X', 'gh-write'],
    ['gh release upload v1 a', 'gh-write'],
    ['gh api repos/o/r -f a=1', 'gh-write'],
    ['gh some-extension list', 'gh-write'],
    ['gh release download v1', undefined],
    ['gh label list', undefined],
    ['gh secret list', undefined],
    ['gh variable get X', undefined],
    // Third review: a dry run turned off by its value, and send-email's `-n`.
    ['npm publish --dry-run false', 'package-publish'],
    ['npm publish --dry-run=false', 'package-publish'],
    ['npm publish --dry-run 0', 'package-publish'],
    ['npm publish --dry-run=no', 'package-publish'],
    ['pnpm publish --dry-run off', 'package-publish'],
    ['git send-email -n 0001.patch', 'git-push'],
    ['npm publish --dry-run', undefined],
    ['npm publish --dry-run=true', undefined],
    ['npm publish --dry-run true', undefined],
    ['git send-email --dry-run 0001.patch', undefined],
    // Third review: options the lists now know, and the shell's command modifiers.
    ['npm --loglevel info publish', 'package-publish'],
    ['npm --tag test publish', 'package-publish'],
    ['coproc git push', 'git-push'],
    ['noglob git push', 'git-push'],
    ['nocorrect git push', 'git-push'],
    // Third review: a later program word in a command is not rescanned, so these stay quiet.
    ['echo git push origin main', undefined],
    ['grep curl notes.txt', undefined],
    ['man ssh', undefined],
    ['which gh', undefined],
    ['brew install gh', undefined],
  ] as const)('review input %j: %s', (command, expected) => {
    expect(outwardCommand(command)).toBe(expected)
  })

  it.each([
    'npm test && git push',
    'env GIT_TRACE=1 git push',
    'timeout 30 git push',
    'git -c http.extraHeader=x push',
    'echo "$(git push)"',
    'sh -c \'bash -c "npm publish"\'',
    'git push\n',
  ])('reaches the outward command inside %j', (command) => {
    expect(outwardCommand(command)).toBeDefined()
  })
})

describe('known gaps', () => {
  it.each(OUTWARD_KNOWN_GAPS.map((gap) => [gap.kind, gap.input] as const))(
    '%s: %j is not matched',
    (_kind, input) => {
      expect(outwardCommand(input)).toBeUndefined()
    },
  )

  it.each(['docs/guide/security.md', 'docs/guide/security.zh-CN.md'])('%s lists every gap input', (path) => {
    const guide = readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8')
    for (const gap of OUTWARD_KNOWN_GAPS) expect(guide).toContain(`\`${gap.input}\``)
  })
})

describe('the hard block keeps its own reading', () => {
  it.each([nested(4, 'ls'), 'eval git push', 'find . -exec ls \\;'])('%j is not hard-blocked', (command) => {
    expect(hardBlockedCommand(command)).toBeUndefined()
  })
})
