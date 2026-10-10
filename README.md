# claude-box

Run Claude Code in a Docker container that can only see the folder you're in.

```sh
cd my-project
npx claude-box                                  # interactive Claude Code
npx claude-box --dangerously-skip-permissions   # any claude args are forwarded
```

Install locally while developing: `npm link` in this folder, then `claude-box` anywhere.

The first run builds the image (`claude-box:<version>`). Run `claude /login` (or
just start `claude-box` and follow the prompt) once; the login is stored in the
Docker volume `claude-box-config`, not in your host `~/.claude`. Alternatively use
`--box-api-key` to pass `ANTHROPIC_API_KEY` from your shell.

## What's protected

| Risk | How |
| --- | --- |
| Shell environment variables | Docker passes none by default. Only `TERM`/`COLORTERM` are forwarded, plus `ANTHROPIC_API_KEY` if you opt in with `--box-api-key`. |
| `.env` and other secret files in the folder | Each match is bind-mounted over with `/dev/null` (read-only), so it appears empty. Secret directories (`.aws`, `.ssh`, ...) get an empty read-only tmpfs. The hidden paths are printed at startup. |
| Files outside the folder | Only the current folder is mounted. Running in `~` or `/` is refused unless you pass `--box-force`. |
| Your SSH keys, git credentials, Docker socket, `~/.claude` | Not mounted. |
| Container escape | All capabilities are dropped, `no-new-privileges` is set, and Claude runs as a non-root user. |

Use `--box-dry-run` to see exactly which files get hidden and the full `docker run` command.

### Custom patterns

Create a `.claudeboxignore` file in the folder:

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
- **Files created after startup.** The scan runs once, when the container starts.
- **Network.** The container has internet access (Claude needs it), so anything it can read could be sent out.
- **Writes.** Claude can change or delete anything in the folder that isn't masked. Commit first.

## Notes

- `node_modules`, `.git`, `dist`, `.next` and similar folders are not scanned.
- Only the current folder is mounted. If you start inside a monorepo subfolder, the repo root isn't visible.
- Update Claude Code with `claude-box --box-rebuild`.
