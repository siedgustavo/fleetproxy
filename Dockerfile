FROM oven/bun:1
WORKDIR /app

# Dependencias primero (cache de capas). bun.lock es cross-platform:
# opencode-ai resuelve el binario de la arquitectura del contenedor.
COPY package.json bun.lock ./
COPY cli/package.json ./cli/
COPY packages/core/package.json ./packages/core/
COPY packages/fleet/package.json ./packages/fleet/
RUN bun install --frozen-lockfile

# Motor vendorizado: binario de un release de opencode, usado HOY SOLO PARA
# `fleetproxy login` (el auth interactivo del proveedor). El serve corre
# @opencode/core IN-PROCESS (mismo versionado: el binario escribe el storage
# que el core lee, y viceversa → mantener ambos en la misma versión X.Y.Z).
# Sin curl en la base: se descarga con el propio bun.
ARG OPENCODE_ENGINE_VERSION=2.2.6
RUN mkdir -p /app/engine && OPENCODE_ENGINE_VERSION="$OPENCODE_ENGINE_VERSION" bun -e 'const v=process.env.OPENCODE_ENGINE_VERSION; const res=await fetch("https://github.com/anomalyco/opencode/releases/download/v"+v+"/opencode-linux-x64.tar.gz"); if(!res.ok) throw new Error("fallo descargando motor v"+v+": HTTP "+res.status); await Bun.write("/tmp/engine.tar.gz", res);' \
    && tar -xzf /tmp/engine.tar.gz -C /app/engine \
    && rm /tmp/engine.tar.gz \
    && chmod +x /app/engine/opencode \
    && /app/engine/opencode --version

COPY . .

# Casa de fleetproxy: auth y config del motor viven en $HOME/.fleetproxy
# (montá un volumen ahí para persistir logins).
ENV HOME=/home/fleetproxy \
    FLEETPROXY_PORT=8787
RUN mkdir -p "$HOME" && chmod 777 "$HOME"
EXPOSE 8787

CMD ["bun", "cli/src/index.ts", "serve"]
