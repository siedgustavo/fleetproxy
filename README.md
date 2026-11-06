# fleetproxy

API **OpenAI-compatible** (`/v1/chat/completions` + `/v1/models`) sobre [opencode](https://opencode.ai):
tus suscripciones de LLM disponibles como endpoint OpenAI, sin que nadie escriba código de proveedor.

```
cliente OpenAI ──HTTP──▶ fleetproxy ──HTTP /api/*──▶ motor opencode ──▶ módulos de la comunidad ──▶ LLM
                         (façade, flota)             (dependencia        (opencode-ai + plugins:
                                                       empaquetada)        auth, catálogo, providers)
```

## Provider-agnóstico

fleetproxy **no conhece proveedores**: habla con el server de opencode y expone lo que ese server
pueda hacer. Los providers (GitHub Copilot, GitLab, OpenAI, Anthropic, Ollama, o el módulo que la
comunidad publique en el ecosistema opencode) se autentican y configuran **dentro de la app**:

- El motor es el paquete npm [`opencode-ai`](https://www.npmjs.com/package/opencode-ai), instalado
  como dependencia de fleetproxy — no hace falta tener opencode en la máquina.
- Todo queda contenido en `~/.fleetproxy` (data, logins, config): nada se comparte con un
  opencode del sistema.
- `fleetproxy login` corre el auth-flow del motor dentro de esa casa.

Los ids de modelo son `providerID/modelID`, tal como los expone el catálogo de opencode:

```bash
curl http://localhost:8787/v1/models
curl http://localhost:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model": "github-copilot/claude-sonnet-4.5", "messages": [{"role": "user", "content": "hola"}]}'
```

## Uso local (Bun)

```bash
bun install
bun cli/src/index.ts serve        # spawnea el motor empaquetado; proxy en :8787
bun cli/src/index.ts models       # catálogo actual
bun cli/src/index.ts login        # auth-flow de un provider (interactivo)
```

`fleetproxy.json` (opcional):

```json
{ "port": 8787, "opencode": { "url": "http://127.0.0.1:4096" } }
```

Sin `opencode.url` se spawnea el motor empaquetado; con url, fleetproxy se **attacha** a ese
server (otro proceso, otra máquina) y no necesita binario alguno.

## Docker

```bash
docker run -p 8787:8787 -v fleetproxy-home:/home/fleetproxy/.fleetproxy \
  ghcr.io/siedgustavo/fleetproxy:latest

# primer login de provider (persiste en el volumen):
docker run --rm -it -v fleetproxy-home:/home/fleetproxy/.fleetproxy \
  ghcr.io/siedgustavo/fleetproxy:latest bun cli/src/index.ts login
```

La imagen trae el motor adentro; el volumen guarda logins y config entre reinicios.

## Monorepo

```
packages/core    → Hono: rutas OpenAI + bridge/HTTP client contra /api/* del motor
packages/fleet   → supervisor del motor: spawn aislado (~/.fleetproxy) o attach; flota (hito 3)
cli              → fleetproxy serve | models | login
```

## Tests

```bash
bun run typecheck
bun test                              # unit + integración (spawn del motor empaquetado)
FLEETPROXY_LIVE_CHAT=1 bun test packages/core/test/integration.test.ts   # chat real
```

El live test requiere un provider autenticado en `~/.fleetproxy` (`fleetproxy login`); sin
`FLEETPROXY_LIVE_MODEL` elige un modelo del catálogo dinámicamente.
