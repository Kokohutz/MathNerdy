FROM node:22-slim

# Claude Code CLI, run headless (`claude -p`). Authenticates with the
# ANTHROPIC_API_KEY environment variable at runtime — no login step needed.
RUN npm install -g @anthropic-ai/claude-code

# Run as a non-root user; Claude Code writes config under $HOME.
RUN useradd --create-home claude
USER claude
ENV HOME=/home/claude

WORKDIR /app
COPY claude-code-wrapper/server.mjs ./server.mjs

ENV PORT=8005
EXPOSE 8005

CMD ["node", "server.mjs"]
