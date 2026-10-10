FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ripgrep ca-certificates curl less procps \
 && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# /claude-config is backed by a named volume so login survives between runs
# without ever touching the host's ~/.claude. World-writable so it also works
# when the container runs as the host uid on Linux.
RUN mkdir -p /claude-config /workspace \
 && chmod 777 /claude-config /workspace /home/node

ENV HOME=/home/node \
    CLAUDE_CONFIG_DIR=/claude-config \
    DISABLE_AUTOUPDATER=1

USER node
WORKDIR /workspace
CMD ["claude"]
