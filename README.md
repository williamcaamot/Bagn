# bagn

Run Claude Code or the Cursor CLI in a Docker container that can only see the folder you're in.
Every image comes with Claude Code, the Cursor CLI and the Salesforce CLI preinstalled, plus
Node.js 22, Python 3 and PostgreSQL for development.

```sh
cd my-project
npx bagn                          # interactive Claude Code
npx bagn --yolo                   # claude --dangerously-skip-permissions
npx bagn --shell                  # bash in the container instead of claude
npx bagn --cursor                 # Cursor CLI instead of claude
npx bagn --sf-org myscratch       # copy an org's login from your sf
npx bagn --ports                  # publish dev ports 3000, 5173, 8000, 8080
npx bagn --help                   # all options
npx bagn -- -p "summarize this"   # everything after -- goes to claude as is
```

The first run asks whether bagn should start Claude Code or the Cursor CLI by default, and
saves the answer in `~/.config/bagn/config.json` (delete it to be asked again).
`--claude` and `--cursor` override it for one run.

Install locally while developing: `npm link` in this folder, then `bagn` anywhere.

The first run builds the image (`bagn:<version>`). Run `claude /login` (or
just start `bagn` and follow the prompt) once per folder; the login is stored in
that folder's Docker volume (`bagn-claude-<folder>-<hash>`), not in your host
`~/.claude`. Alternatively use `--api-key` to pass `ANTHROPIC_API_KEY` from your shell.

## Containers

Each folder gets its own container. New containers are named after the folder plus two
random words, e.g. `my-project-brave-otter`, so they're easy to recognize when you pick one again. Running `bagn` again in a folder that already
has containers lists them: pick one with ↑/↓ and Enter (the most recently used is
selected), or choose "Start a new container". A stopped container is started again.
Without an interactive terminal the most recent one is reused. Each `bagn` call is a separate session
(`docker exec`), so you can have several terminals open on one folder at once,
and they share the same container. Different folders get separate containers. The
container stops when its last session ends, and the next run starts it again.

Closing a terminal window instead of exiting claude leaves the session running in the
container with nothing attached, so the container never stops. `bagn --list` shows these
as orphaned, and `bagn --clean` stops them (claude gets a TERM first, so `/resume` still
has the conversation). bagn knows a session is orphaned because the bagn process that
started it is gone. Sessions started by an older bagn can't be told apart that way: the
newest ones count as live, one for each `docker exec` still running on your computer.

| Flag | What it does |
| --- | --- |
| `--yolo` | Skip permission prompts: `claude --dangerously-skip-permissions`, or `cursor-agent --yolo` |
| `--list` | List all bagn containers, most recently used first, with their folder and how many sessions are open |
| `--pick` | Pick from all containers, from any folder, with ↑/↓ and Enter, or start a new one |
| `--new` | Start a new container for this folder without asking |
| `--shell` | Open `bash` in the container instead of `claude`. Combines with `--pick`/`--new` |
| `--claude` | Run Claude Code this time, whatever the default is |
| `--cursor` | Run the Cursor CLI (`cursor-agent`) this time, whatever the default is |
| `--sf-org <org>` | Copy the login for an org from `sf` on your computer into the container's `sf`, keeping its alias. Repeatable |
| `--no-org` | Don't ask for a scratch org when starting a new container |
| `--link-org` | Pick a container, then one of the scratch orgs from `sf` on your computer (↑/↓ and Enter), and copy that org's login into the container |
| `--limits[=memory=8g,cpus=4,pids=2048]` | Limit the container's memory (no swap), CPUs and number of processes, e.g. against a fork bomb or runaway build. Keys left out get the default shown, lowered to fit what Docker has. Applied when a container is created, and changed with `docker update` when one is reused |
| `--ports[=3000,5173,8000,8080]` | Publish container ports on your computer's `127.0.0.1`, each as `port` or `host:container` (e.g. `--ports=3000,15432:5432`). See [Dev tools and ports](#dev-tools-and-ports) |
| `--clean` | Stop sessions left running after their terminal was closed, and stop containers left without sessions |
| `--prune` | Remove all stopped bagn containers |

A container is only reused if it was built from the current image and the folder's
hidden secret files and read-only git files are the same as when it was created. The mounts can't be
changed on an existing container. If either has changed, a new container is started and the
old one is left for `--prune`.

Unknown options are an error. Arguments for `claude` go after `--`, as do arguments for
`cursor-agent` with `--cursor` and `bash` with `--shell` (`bagn --shell -- -c "git status"`).
Most claude options can also be set inside a session, e.g. `/resume` and `/model`.

Each folder has its own Claude Code config volume, `bagn-claude-<folder>-<hash>`
(login, settings, plugins, history), shared by that folder's containers but by no
other folder. A hook, MCP server or setting planted from one project therefore can't run in
another. The first time a folder gets its volume, it's seeded from the old shared
`bagn-claude` volume, if you have one: settings, `CLAUDE.md`, agents, commands, skills
and plugins, plus only this folder's sessions and prompt history, so `/resume` still finds
them. The login and other folders' history aren't copied, so you log in again. Once
every folder you use has its own volume, you can `docker volume rm bagn-claude`.
`docker volume ls --filter label=bagn.folder` lists the folder volumes. The folder is
mounted at the same path inside the container as on your machine (e.g.
`/Users/you/project`), so Claude Code keeps separate sessions, `--resume` history and
memory for each folder, and the paths it prints match yours. Folders under system
paths like `/usr`, `/var` or `/tmp` itself are mounted at `/workspace/<name>-<hash>` instead.

## Dev tools and ports

Every image has Node.js 22 with npm, Python 3 with pip and venv, and PostgreSQL. `npm install -g`
and `pip install` install into the container's home folder, since it can't write to `/usr`.

PostgreSQL isn't running until you (or Claude) run `pg-start`. The first time, it creates a
database cluster in `~/.pgdata`, inside the container. The superuser is `postgres` with no
password, so `psql` works as is, and apps can use
`postgres://postgres@localhost:5432/postgres`. Stop it with `pg_ctl stop`. Like any background
process, it's stopped when the container's last session ends, so run `pg-start` again in the next
one. The data stays with the container; `--new` starts with an empty one.

To open a dev server from your browser, start the container with `--ports`. Without a value it
publishes 3000, 5173, 8000 and 8080; otherwise list them, as `port` or `host:container`:

```sh
bagn --ports                      # 3000, 5173, 8000, 8080
bagn --ports=4200,15432:5432      # 4200, and postgres on localhost:15432 on your computer
```

Ports are published on `127.0.0.1` only, so other machines on your network can't reach them.
A server in the container must listen on all interfaces (`0.0.0.0`), not `localhost`, e.g.
`vite --host`, `next dev -H 0.0.0.0`, `python manage.py runserver 0.0.0.0:8000` or
`uvicorn --host 0.0.0.0`.

Ports can't be changed on an existing container. With `--ports`, only containers that publish
exactly those ports are reused, and otherwise a new one is started. Without `--ports`, any of
the folder's containers is reused, whatever it publishes. A port can only be published by one
running container, and not while something on your computer uses it.

## Cursor and Salesforce CLIs

The Cursor CLI (`cursor-agent`, also available as `agent`) is installed in every
image. Run it with `bagn --cursor` (or make it the default on the first run), or call it from `--shell`/Claude. Log in
once per folder with `bagn --cursor -- login`. The login and settings are kept in the
folder's Docker volume `bagn-cursor-<folder>-<hash>`. Nothing is copied from the old
shared `bagn-cursor` volume, which you can delete.

The Salesforce CLI (`sf`) is also installed in every image. Its logins are kept in the
container itself, so a container can only use the orgs copied into it, and
`--prune` deletes them with the container. (`--sf` is no longer needed and is ignored.)
The old shared `bagn-sf` volume isn't used any more; delete it with `docker volume rm bagn-sf`.

When bagn starts a new container in an interactive terminal, it lists the active scratch
orgs from `sf` on your computer. Pick one (or "None") and its login is copied into the
container, and it becomes that container's default org (`SF_TARGET_ORG`, shown in
the container list), so each container can work against its own scratch org. This is
skipped with `--sf-org` or `--no-org`, or if `sf` isn't installed on your computer.

To use any other org you're already logged in to on your computer (e.g. a scratch org), copy its
login in:

```sh
bagn --sf-org myscratch                   # copy the login, then start claude
bagn --sf-org myscratch --sf-org DevHub   # several orgs, e.g. its Dev Hub too
```

This reads the org's SFDX auth URL from `sf` on your computer (`sf org auth show-sfdx-auth-url`,
or `sf org display --verbose` on older versions) and passes it on stdin to
`sf org login sfdx-url` in the container, under the same alias. Your project's
`.sf/config.json` (`target-org`, `target-dev-hub`) then works unchanged. Run it again
after re-authorizing an org. It only works for orgs logged in with a web login (they have
a refresh token). Orgs authorized with JWT, including scratch orgs created from a
JWT-authorized Dev Hub, can't be copied. Mounting your `~/.sfdx` wouldn't work either, because on
macOS those tokens are encrypted with a key in your Keychain.

To log in from inside the container instead, use `sf org login device` (or
`sf org login jwt`) in a `bagn --shell` session. `sf org login web` doesn't work, because
it waits for a callback on the container's localhost, which your browser can't reach.

bagn used to be called claude-box. The first run copies the old `claude-box-config`
volume into `bagn-claude`, so folder volumes are seeded from it, and a `.claudeboxignore` file is
still read. Old containers aren't reused. `--prune` removes the stopped ones, and you
can delete the old volumes with `docker volume rm claude-box-config claude-box-cursor claude-box-sf`.

Anything running in a container (including Claude) can read the logins in it: the
folder's Claude and Cursor logins and the orgs copied into that container.

## What's protected

| Risk | How |
| --- | --- |
| Shell environment variables | Docker passes none by default. Only `TERM`/`COLORTERM` are forwarded, plus `ANTHROPIC_API_KEY` if you opt in with `--api-key`. They're passed per session, so they're never stored in the container's config. |
| `.env` and other secret files in the folder | Each match is bind-mounted over with `/dev/null` (read-only), so it appears empty. Secret directories (`.aws`, `.ssh`, ...) get an empty read-only tmpfs. The hidden paths are printed at startup. |
| Files outside the folder | Only the current folder is mounted. Running in `~` or `/` is refused unless you pass `--force`. |
| Your SSH keys, git credentials, Docker socket, `~/.claude` | Not mounted. |
| Git running planted code on your computer | `.git/config` and `.git/hooks` are mounted read-only, as are `config.worktree` files and the `config` and `hooks` of submodules in `.git/modules`, plus a `core.hooksPath` inside the folder (e.g. `.husky`). A missing `.git/hooks` is created first so it can't be added. Otherwise the container could add a hook or a `core.fsmonitor` command that runs the next time you use git on your computer. The protected paths are printed at startup. |
| One project affecting others | Claude Code and Cursor config (hooks, MCP servers, settings, plugins, logins) is per folder, and Salesforce logins are per container. |
| Dev servers and postgres seen from the network | Only published with `--ports`, and then only on `127.0.0.1`. |
| Runaway processes | With `--limits`, memory, CPUs and the number of processes are capped. |
| Container escape | All capabilities are dropped, `no-new-privileges` is set, and Claude runs as a non-root user. |

Use `--dry-run` to see exactly which files get hidden and the full `docker run`/`docker exec` commands.

### Custom patterns

Create a `.bagnignore` file in the folder:

```
# hide these too
secrets.yaml
config/prod.json
# un-hide a default
!.npmrc
```

Patterns without `/` match a file or directory name anywhere. Patterns with `/` match the path from the folder root. `*` and `?` work as globs.

Defaults: `.env`, `.env.*` (except `.env.example`/`.sample`/`.template`), `.envrc`, `.dev.vars`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `id_rsa*`/`id_ecdsa*`/`id_ed25519*` (except `*.pub`), `.npmrc`, `.yarnrc.yml`, `.pypirc`, `.netrc`, `.pgpass`, `credentials`, `credentials.json`, `service-account*.json`, `*.tfvars`, `*.tfstate*`, `.aws`, `.ssh`, `.gnupg`, `.docker`, `.kube`.

## What's NOT protected

- **Git history.** `.git` is mounted so git works. A secret that was ever committed can be read from history.
- **Secrets in ordinary files.** Hard-coded keys in source code, or secret files with names that match no pattern, are visible.
- **Files created after startup.** The scan runs when a session starts. A secret file created while a session is running stays visible until the next start, which then gets a new container.
- **Network.** The container has internet access (Claude needs it), so anything it can read could be sent out.
- **Writes.** Claude can change or delete anything in the folder that isn't masked. Commit first.
- **Other files your computer runs.** Only git's own config and hooks are read-only. Project files that tools on your computer run, such as `package.json` scripts, `Makefile`, `.vscode/tasks.json`, `.envrc` or a project's `.claude/settings.json` hooks, can still be changed. Review the diff before running anything from the folder on your computer.
- **New repos.** If the folder has no `.git` when the container is created, a repo created inside it later (`git init`) has writable hooks. Start a new container (`--new`) after creating it.

## Notes

- `node_modules`, `.git`, `dist`, `.next` and similar folders are not scanned.
- Only the current folder is mounted. If you start inside a monorepo subfolder, the repo root isn't visible.
- Update Claude Code, Cursor, the Salesforce CLI and the dev tools with `bagn --rebuild`. It rebuilds without Docker's layer cache, so it reinstalls the latest versions and pulls the latest base image.
- Containers keep their own filesystem changes (e.g. tools installed in `~`) between sessions. Use `--new` for a clean one.
- Background processes started in a session are stopped when the container's last session ends.
- Since `.git/config` is read-only, git commands in the container that change it fail, e.g. `git remote add`, `git push -u`, `git branch --set-upstream-to` or installing hooks (`husky`, `pre-commit install`). Run those on your computer. Committing, branching, fetching and pushing work. A change to `.git/config` made on your computer shows up in a running container after it restarts (it stops when its last session ends).
