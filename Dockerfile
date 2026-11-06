FROM oven/bun:1
WORKDIR /app

# Dependencias primero (cache de capas). bun.lock es cross-platform:
# opencode-ai resuelve el binario de la arquitectura del contenedor.
COPY package.json bun.lock ./
COPY cli/package.json ./cli/
COPY packages/core/package.json ./packages/core/
COPY packages/fleet/package.json ./packages/fleet/
RUN bun install --frozen-lockfile

COPY . .

# Casa de fleetproxy: auth y config del motor viven en $HOME/.fleetproxy
# (montá un volumen ahí para persistir logins).
ENV HOME=/home/fleetproxy \
    FLEETPROXY_PORT=8787
RUN mkdir -p "$HOME" && chmod 777 "$HOME"
EXPOSE 8787

CMD ["bun", "cli/src/index.ts", "serve"]
