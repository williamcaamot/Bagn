# bagn

Run Claude Code or the Cursor CLI in a Docker container that can only see the folder you're in.
Every image comes with Claude Code, the Cursor CLI and the Salesforce CLI preinstalled.

```sh
cd my-project
npx bagn                          # interactive Claude Code
npx bagn --yolo                   # claude --dangerously-skip-permissions
npx bagn --shell                  # bash in the container instead of claude
npx bagn --cursor                 # Cursor CLI instead of claude
npx bagn --sf-org myscratch       # copy an org's login from your sf
npx bagn --help                   # all options
npx bagn -- -p "summarize this"   # everything after -- goes to claude as is
```

The first run asks whether bagn should start Claude Code or the Cursor CLI by default, and
saves the answer in `~/.config/bagn/config.json` (delete it to be asked again).
`--claude` and `--cursor` override it for one run.

Install locally while developing: `npm link` in this folder, then `bagn` anywhere.

The first run builds the image (`bagn:<version>`). Run `claude /login` (or
just start `bagn` and follow the prompt) once; the login is stored in the
Docker volume `bagn-claude`, not in your host `~/.claude`. Alternatively use
`--api-key` to pass `ANTHROPIC_API_KEY` from your shell.

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
| `--sf-org <org>` | Copy the login for an org from `sf` on your computer into the containers' `sf`, keeping its alias. Repeatable |
| `--no-org` | Don't ask for a scratch org when starting a new container |
| `--link-org` | Pick a container, then one of the scratch orgs from `sf` on your computer (↑/↓ and Enter), and copy that org's login into the container |
| `--clean` | Stop sessions left running after their terminal was closed, and stop containers left without sessions |
| `--prune` | Remove all stopped bagn containers |

A container is only reused if it was built from the current image and the folder's
hidden secret files are the same as when it was created. The secret mounts can't be
changed on an existing container. If either has changed, a new container is started and the
old one is left for `--prune`.

Unknown options are an error. Arguments for `claude` go after `--`, as do arguments for
`cursor-agent` with `--cursor` and `bash` with `--shell` (`bagn --shell -- -c "git status"`).
Most claude options can also be set inside a session, e.g. `/resume` and `/model`.

The Claude login volume `bagn-claude` is shared by all containers. The folder is
mounted at the same path inside the container as on your machine (e.g.
`/Users/you/project`), so Claude Code keeps separate sessions, `--resume` history and
memory for each folder, and the paths it prints match yours. Folders under system
paths like `/usr`, `/var` or `/tmp` itself are mounted at `/workspace/<name>-<hash>` instead.

## Cursor and Salesforce CLIs

The Cursor CLI (`cursor-agent`, also available as `agent`) is installed in every
image. Run it with `bagn --cursor` (or make it the default on the first run), or call it from `--shell`/Claude. Log in
once with `bagn --cursor -- login`. The login is kept in the Docker volume
`bagn-cursor`.

The Salesforce CLI (`sf`) is also installed in every image. Its logins are kept in the
volume `bagn-sf`, so every container has them. (`--sf` is no longer needed and is ignored.)

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

bagn used to be called claude-box. The first run copies the old `claude-box-*` volumes
into the new `bagn-*` ones, so you stay logged in, and a `.claudeboxignore` file is
still read. Old containers aren't reused. `--prune` removes the stopped ones, and you
can delete the old volumes with `docker volume rm claude-box-config claude-box-cursor claude-box-sf`.

Like the Claude login, these logins are shared by every container and folder,
and anything running in the container (including Claude) can read them.

## What's protected

| Risk | How |
| --- | --- |
| Shell environment variables | Docker passes none by default. Only `TERM`/`COLORTERM` are forwarded, plus `ANTHROPIC_API_KEY` if you opt in with `--api-key`. They're passed per session, so they're never stored in the container's config. |
| `.env` and other secret files in the folder | Each match is bind-mounted over with `/dev/null` (read-only), so it appears empty. Secret directories (`.aws`, `.ssh`, ...) get an empty read-only tmpfs. The hidden paths are printed at startup. |
| Files outside the folder | Only the current folder is mounted. Running in `~` or `/` is refused unless you pass `--force`. |
| Your SSH keys, git credentials, Docker socket, `~/.claude` | Not mounted. |
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

## Notes

- `node_modules`, `.git`, `dist`, `.next` and similar folders are not scanned.
- Only the current folder is mounted. If you start inside a monorepo subfolder, the repo root isn't visible.
- Update Claude Code, Cursor and the Salesforce CLI with `bagn --rebuild`. It rebuilds without Docker's layer cache, so it reinstalls the latest versions and pulls the latest base image.
- Containers keep their own filesystem changes (e.g. tools installed in `~`) between sessions. Use `--new` for a clean one.
- Background processes started in a session are stopped when the container's last session ends.
