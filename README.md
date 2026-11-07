# fleetproxy

API **OpenAI-compatible** (`/v1/chat/completions` + `/v1/models`) sobre [opencode](https://opencode.ai):
tus suscripciones de LLM disponibles como endpoint OpenAI, sin que nadie escriba código de proveedor.
Con `token` en `fleetproxy.json` (o `FLEETPROXY_TOKEN`) las rutas `/v1/*` exigen
`Authorization: Bearer <token>`, como OpenAI.
En Docker/cluster, `url` (o `FLEETPROXY_URL`) hace que los OAuth del motor vuelvan a
`<url>/auth/callback`: fleetproxy reenvía ese path al proceso de login (puerto fijo,
`oauth.callbackPort`), sin depender de un `127.0.0.1` que el browser no ve.

```
cliente OpenAI ──HTTP──▶ fleetproxy ──en proceso──▶ @opencode/core ──▶ plugins de provider ──▶ LLM
                         (façade Hono +            (runtime opencode    (auth OAuth, catálogo
                          bridge CoreBridge)         como librería)       models.dev, providers)
```

> Desde `v0.2` el motor corre **in-process** como librería (`@opencode/core` + `@opencode/ai`), sin el
> binario `opencode serve`. El faça hace **una sola llamada al proveedor** por request, con el `system`
> y los roles del historial tal cuales (sin system prompt ni agent loop del runtime). El binario del
> motor queda solo para el `fleetproxy login` interactivo; con `opencode.url` sigue habiendo un bridge
> HTTP legado contra un `opencode serve` remoto.

## Provider-agnóstico

fleetproxy **no conhece proveedores**: usa el runtime de opencode como librería y expone lo que sus
módulos puedan hacer. Los providers (GitHub Copilot, GitLab, OpenAI, Anthropic, Ollama, o el módulo que la
comunidad publique en el ecosistema opencode) se autentican y configuran **dentro de la app**:

- `@opencode/core` trae los providers built-in (plugins internos: gitlab, github-copilot, openai, …) con
  su auth y su catálogo models.dev; `opencode-ai` (npm) provee el **binario** solo para `login`, y la
  imagen Docker lo **vendoriza desde un release de GitHub** (`OPENCODE_ENGINE_VERSION`, alineado a la
  versión del core — mismo storage comparten). No hace falta tener opencode en la máquina.
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
bun cli/src/index.ts serve        # levanta el motor in-process; proxy en :8787
bun cli/src/index.ts models       # catálogo actual
bun cli/src/index.ts login        # auth-flow de un provider (interactivo)
```

`fleetproxy.json` (opcional):

```json
{ "port": 8787, "token": "sk-…", "url": "https://…", "opencode": { "url": "http://127.0.0.1:4096" } }
```

Sin `opencode.url` el motor corre **in-process** (`@opencode/core`). Con `opencode.url`, fleetproxy usa
el bridge HTTP legado contra ese server opencode (otro proceso, otra máquina).

> `fleetproxy login` necesita un binario de la **misma línea** que el core (el storage 1.x de npm
> `opencode-ai@1.19.5` no lo lee `@opencode/core` 2.x). En Docker ya se vendoriza en la build; en desarrollo
> local corré `bun run engine:get` (baja el release de GitHub a `./engine`, que `resolveOpencodeBin` prioriza).

## Docker

```bash
docker run -p 8787:8787 -v fleetproxy-home:/home/fleetproxy/.fleetproxy \
  ghcr.io/siedgustavo/fleetproxy:latest

# primer login de provider (persiste en el volumen):
docker run --rm -it -v fleetproxy-home:/home/fleetproxy/.fleetproxy \
  ghcr.io/siedgustavo/fleetproxy:latest bun cli/src/index.ts login
```

El serve no necesita binario (el core va en `node_modules`); el volumen guarda logins y config entre
reinicios, y el binario vendorizado se usa para el `login` dentro del contenedor.

## Monorepo

```
packages/core    → Hono: rutas OpenAI (SSE incremental) + bridges al motor:
                   CoreBridge (in-process, @opencode/core vía Engine) y OpencodeBridge (HTTP legado)
packages/fleet   → home/XDG aislado (~/.fleetproxy), resolución del binario (login), flota (hito 3)
cli              → fleetproxy serve | models | login
scripts/         → get-engine.ts: vendoriza el binario del motor a ./engine (para login local)
spike/           → scripts del spike de arquitectura core-in-process (documentación ejecutable)
```

## Tests

```bash
bun run typecheck
bun test                              # unit + integración (spawn del motor empaquetado)
FLEETPROXY_LIVE_CHAT=1 bun test packages/core/test/integration.test.ts   # chat real
```

El live test requiere un provider autenticado en `~/.fleetproxy` (`fleetproxy login`); sin
`FLEETPROXY_LIVE_MODEL` elige un modelo del catálogo dinámicamente.
