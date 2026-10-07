# dsh-git-view

A read-only **Git** tab in the DSH right sidebar. It shows the repository state of the folder a session works in; it never changes the repository.

- Branch (or detached HEAD), upstream ahead/behind, stash count, and a `worktree` badge when the session works in a linked git worktree. Only the worktree the session actually works in is shown; there is no worktree or branch picker.
- Sections: conflicts (with merge / rebase / cherry-pick state), changes, staged changes, untracked files, commits on the branch vs the default base, and history.
- Diff viewer: inline or side-by-side, word wrap, ignore whitespace, whole file, *View all* with a file list, image diffs (side by side, swipe, onion skin), binary and large-file placeholders.
- List or tree layout, file filter, auto-refresh while the tab is visible.
- No stage, unstage, commit, checkout or any other write action.

## Install

```powershell
dsh plugin --profile web add "github:jitsmaster/dsh-plugins#path:/dsh-git-view"
```

From a local clone use a link so edits apply without reinstalling:

```powershell
dsh plugin --profile web add "link:D:/dev/ai/dsh-plugins/dsh-git-view"
```

Restart the DSH server, then refresh the browser. Open the right sidebar and pick **Git** from the guide page. The session's folder is known after its first message.

Server-side files (`index.js`, `git.js`, `gitpath.js`, `limiter.js`, `sessions.js`, `server.js`) need a server restart after edits; `lib/client.js` only needs a browser refresh.

## Configuration

Optional plugin config keys:

| Key | Default | Meaning |
| --- | --- | --- |
| `stateDir` | `$DSH_HOME/git-view` (`~/.dsh/git-view`) | Where `sessions.json` (session -> folder / worktree) is kept. An unusable directory is logged and sessions are simply not persisted; the plugin still loads. |
| `gitPath` | found on `PATH` | Absolute path of the git executable. Git is never resolved against a repository's folder, and if no absolute git is found the Git tab reports "git executable not found" instead of running a bare `git`. |
| `port` | `3082` | Loopback API port. The shipped client always calls `3082` unless the page sets `window.__GIT_VIEW_PORT__`, which the plugin cannot do, so leave this alone unless you also change that. |

Git child processes receive only an allow-listed environment (`PATH`, `SystemRoot`, `HOME`/`USERPROFILE`, `APPDATA`, `TEMP`, `LANG`/`LC_*`, `ProgramData`, `ProgramFiles*`, plus the plugin's own `GIT_*` flags); other variables, such as tokens, are not forwarded.

## How it works

The host half records each session's cwd and the worktree its tool calls touch (`~/.dsh/git-view/`) and runs a small HTTP API on **`127.0.0.1:3082`** (loopback, local only). The tab calls it from the browser, so it works only when the browser runs on the same machine as DSH. There is no Tailscale or other remote access in this version.

Routes: `/v1/snapshot`, `/v1/commit`, `/v1/diff`, `/v1/history`, `/v1/blob`. The API is read-only and accepts requests only from the DSH web origin.

## Limits

- No syntax highlighting in diffs.
- Port 3082 is fixed for the shipped client (see `port` above); when git is overloaded the API answers HTTP 429 and the tab retries or says "busy, try again". If the port is taken (or the plugin is not loaded) the tab shows "Git service unreachable (...). Is dsh-git-view loaded? Restart DSH after installing it."
- Lists are capped at 1,000 changed files.

## Development

```powershell
cd dsh-git-view
npm test                      # node --test, no dependencies
node test/harness/serve.mjs   # UI harness on http://127.0.0.1:3090 with a demo repo (API on :3083)
```

The harness (dev only, not shipped) takes esbuild from `require.resolve('esbuild')` if installed, otherwise from the DSH checkout's pnpm store; React and react-dom always default to hardcoded `D:/dev/DSH/node_modules/.pnpm/react@18.3.1…` paths, whose versions may have moved. Override with `--esbuild`, `--react`, `--react-dom`; a missing path stops with an error naming the flag.

## Pull request

The header shows `PR: <url>` for the checked-out branch when a pull request exists (open preferred, else the latest merged/closed one, with its state). It is looked up read-only through `gh pr list` (GitHub `origin`) or `az repos pr list` (Azure DevOps `origin`, simple org/project/repo names only), cached for a minute; no CLI, no login or no PR means nothing is shown. If a DSH session is titled `PR <number>`, a **PR session** button opens it (needs a DSH that provides `uiWorkspace`).
