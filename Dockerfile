# Steal the Brainrot - game + matchmaking relay in one container.
# No dependencies to install: the server is plain Node.
FROM node:20-alpine

WORKDIR /app
COPY . .

# Build the bundle and point it at this same host for multiplayer
RUN node tools/build.mjs --relay=auto --leaderboard=auto

# The world leaderboard lives in DATA_DIR. Mount a volume here (see fly.toml)
# or it is wiped with the container on every deploy.
RUN mkdir -p /data
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["node", "server/server.js", "--root", "dist"]
