FROM node:22-bookworm-slim

# Python and PostgreSQL for development. Debian's package would create a
# cluster owned by the postgres user, which the container user can't run;
# pg-start creates one in $PGDATA instead. libnss-wrapper gives the host uid
# (on Linux) a user name, which initdb and postgres insist on.
RUN mkdir -p /etc/postgresql-common/createcluster.d \
 && echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.d/bagn.conf \
 && apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl less procps \
      python3 python3-pip python3-venv python-is-python3 \
      postgresql postgresql-contrib libnss-wrapper \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s "$(ls -d /usr/lib/postgresql/*/ | head -n 1)" /usr/lib/postgresql/current

ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Cursor CLI. The installer puts it under $HOME, so install it into /opt/cursor
# and link it onto the PATH, where it works for whatever uid the container runs as.
RUN curl -fsSL https://cursor.com/install -o /tmp/cursor-install.sh \
 && HOME=/opt/cursor bash /tmp/cursor-install.sh \
 && rm /tmp/cursor-install.sh \
 && chmod -R a+rX /opt/cursor \
 && ln -s /opt/cursor/.local/bin/cursor-agent /usr/local/bin/cursor-agent \
 && ln -s /opt/cursor/.local/bin/agent /usr/local/bin/agent

# /claude-config is backed by a named volume (one per folder) so login survives
# between runs without ever touching the host's ~/.claude. World-writable so it also works
# when the container runs as the host uid on Linux.
RUN mkdir -p /claude-config /workspace \
 && chmod 777 /claude-config /workspace /home/node

# Cursor keeps settings in ~/.cursor and its login in ~/.config/cursor. Both
# point into /cursor-config, a named volume per folder. Owned by
# node because Cursor chmods them, which only the owner may do.
RUN mkdir -p /cursor-config/home /cursor-config/config /home/node/.config \
 && chmod -R 777 /cursor-config /home/node/.config \
 && chown -R node:node /cursor-config \
 && ln -s /cursor-config/home /home/node/.cursor \
 && ln -s /cursor-config/config /home/node/.config/cursor

# Salesforce CLI. Its logins (~/.sf, ~/.sfdx) live in /sf-config, which is
# not a volume, so each container has only the orgs copied into it.
RUN npm install -g @salesforce/cli \
 && mkdir -p /sf-config/sf /sf-config/sfdx \
 && chmod -R 777 /sf-config \
 && ln -s /sf-config/sf /home/node/.sf \
 && ln -s /sf-config/sfdx /home/node/.sfdx

# ios talks to the bridge that bagn --ios starts on the Mac.
COPY docker/pg-start docker/ios /usr/local/bin/
RUN chmod 755 /usr/local/bin/pg-start /usr/local/bin/ios

# pip and npm -g install into ~, since the container user can't write to
# /usr. The container is throwaway, so pip may install outside a venv.
ENV HOME=/home/node \
    CLAUDE_CONFIG_DIR=/claude-config \
    DISABLE_AUTOUPDATER=1 \
    SF_AUTOUPDATE_DISABLE=true \
    SF_USE_GENERIC_UNIX_KEYCHAIN=true \
    PGDATA=/home/node/.pgdata \
    PGHOST=localhost \
    PGUSER=postgres \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    NPM_CONFIG_PREFIX=/home/node/.npm-global \
    PATH=/usr/lib/postgresql/current/bin:/home/node/.local/bin:/home/node/.npm-global/bin:$PATH

USER node
WORKDIR /workspace
CMD ["claude"]
