FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl less procps \
 && rm -rf /var/lib/apt/lists/*

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

# /claude-config is backed by a named volume so login survives between runs
# without ever touching the host's ~/.claude. World-writable so it also works
# when the container runs as the host uid on Linux.
RUN mkdir -p /claude-config /workspace \
 && chmod 777 /claude-config /workspace /home/node

# Cursor keeps settings in ~/.cursor and its login in ~/.config/cursor. Both
# point into /cursor-config, a named volume shared by all containers. Owned by
# node because Cursor chmods them, which only the owner may do.
RUN mkdir -p /cursor-config/home /cursor-config/config /home/node/.config \
 && chmod -R 777 /cursor-config /home/node/.config \
 && chown -R node:node /cursor-config \
 && ln -s /cursor-config/home /home/node/.cursor \
 && ln -s /cursor-config/config /home/node/.config/cursor

# Salesforce CLI. Its login (~/.sf, ~/.sfdx) lives in the /sf-config volume,
# shared by all containers.
RUN npm install -g @salesforce/cli \
 && mkdir -p /sf-config/sf /sf-config/sfdx \
 && chmod -R 777 /sf-config \
 && ln -s /sf-config/sf /home/node/.sf \
 && ln -s /sf-config/sfdx /home/node/.sfdx

ENV HOME=/home/node \
    CLAUDE_CONFIG_DIR=/claude-config \
    DISABLE_AUTOUPDATER=1 \
    SF_AUTOUPDATE_DISABLE=true \
    SF_USE_GENERIC_UNIX_KEYCHAIN=true

USER node
WORKDIR /workspace
CMD ["claude"]
