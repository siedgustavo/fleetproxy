# fleetproxy

API **OpenAI-compatible** (`/v1/chat/completions` + `/v1/models`) sobre [opencode](https://opencode.ai):
tus suscripciones de LLM disponibles como endpoint OpenAI, sin que nadie escriba código de proveedor.
Con `token` en `fleetproxy.json` (o `FLEETPROXY_TOKEN`) las rutas `/v1/*` y `/auth/login*` exigen
`Authorization: Bearer <token>`, como OpenAI.

```
cliente OpenAI ──HTTP──▶ fleetproxy ──en proceso──▶ @opencode/core ──▶ plugins de provider ──▶ LLM
                         (façade Hono +            (runtime opencode    (auth OAuth, catálogo
                          bridge CoreBridge)         como librería)       models.dev, providers)
```

> Desde `v0.2` el motor corre **in-process** como librería (`@opencode/core` + `@opencode/ai`), sin el
> binario `opencode serve`. El faça hace **una sola llamada al proveedor** por request, con el `system`
> y los roles del historial tal cuales (sin system prompt ni agent loop del runtime). Desde `v0.2.2`
> también el **login OAuth es in-process** (servicio `Integration` del core, endpoints `/auth/*`); el
> binario queda solo para `fleetproxy auth` (legacy) y los tests de integración. Con `opencode.url`
> sigue habiendo un bridge HTTP legado contra un `opencode serve` remoto (sin `/auth/*`).

## Provider-agnóstico

fleetproxy **no conhece proveedores**: usa el runtime de opencode como librería y expone lo que sus
módulos puedan hacer. Los providers (GitHub Copilot, GitLab, OpenAI, Anthropic, Ollama, o el módulo que la
comunidad publique en el ecosistema opencode) se autentican y configuran **dentro de la app**:

- `@opencode/core` trae los providers built-in (plugins internos: gitlab, github-copilot, openai, …) con
  su auth (servicio `Integration`: device flow, PKCE/loopback, forms del método) y su catálogo
  models.dev. No hace falta tener opencode en la máquina ni binario para loguearse.
- Todo queda contenido en `~/.fleetproxy` (data, logins, config): nada se comparte con un
  opencode del sistema.
- `fleetproxy login <provider>` corre el auth-flow del motor dentro de esa casa: contra un fleetproxy
  corriendo (`--url`/`FLEETPROXY_URL`, lo normal en Docker/cluster) o embebido en el propio proceso.

## Login OAuth

```bash
fleetproxy login github-copilot              # device flow: muestra URL + código, espera y listo
fleetproxy login github-copilot --field deploymentType=enterprise --field enterpriseUrl=acme.ghe.com
fleetproxy login gitlab --url https://fleetproxy.apps.sied.ar --token "$FLEETPROXY_TOKEN"
```

- **Device flow** (GitHub Copilot, DigitalOcean…): funciona desde cualquier lado — el CLI imprime
  URL + código, el browser va directo al proveedor y el server hace el polling.
- **Loopback** (el listener del provider escucha en `127.0.0.1` con puerto fijo del core: gitlab
  `:8080`, digitalocean `:1456`, openai `:1455`): contra un motor **local** el navegador del mismo
  machine lo alcanza. En remoto hace falta `kubectl port-forward` al pod, o pegar la URL del redirect
  en `GET /auth/callback?provider=<p>&attempt=<id>&code=<c>` / `POST /auth/login/<id>/complete`.
- Los campos del form del método (p. ej. `deploymentType` de Copilot) se autocompletan con su primera
  opción; `--field clave=valor` (repetible) los overridea.

HTTP (token en `/auth/login*`; `/auth/callback` es para el browser y va sin token):

```
POST   /auth/login                 { provider, method?, answer? } → { attemptID, url, instructions, mode, answer }
GET    /auth/login/:attempt?provider=<p>          → { attemptID, status: pending|complete|failed|expired, message? }
POST   /auth/login/:attempt/complete  { provider, code? }   # flujos "code" o pegar la URL del redirect
DELETE /auth/login/:attempt?provider=<p>          # cancela y libera el listener
GET    /auth/callback?provider=<p>&attempt=<id>&code=<c>    # HTML para el navegador
```

## Uso local (Bun)

```bash
bun install
bun cli/src/index.ts serve                    # levanta el motor in-process; proxy en :8787
bun cli/src/index.ts models                   # catálogo actual
bun cli/src/index.ts login github-copilot     # auth-flow (embebido, o --url contra un serve)
bun cli/src/index.ts auth list                # (legacy) auth del binario empaquetado
```

`fleetproxy.json` (opcional):

```json
{ "port": 8787, "token": "sk-…", "url": "https://…", "opencode": { "url": "http://127.0.0.1:4096" } }
```

Sin `opencode.url` el motor corre **in-process** (`@opencode/core`). Con `opencode.url`, fleetproxy usa
el bridge HTTP legado contra ese server opencode (otro proceso, otra máquina).

> El binario del motor (`opencode-ai` npm, o vendorizado vía `bun run engine:get` → `./engine`) ya no
> interviene en el login: solo en `fleetproxy auth` y en los tests de integración del bridge legado.
> Debe ser de la **misma línea** que el core (el storage 1.x de `opencode-ai@1.19.5` no lo lee
> `@opencode/core` 2.x).

## Docker

```bash
docker run -p 8787:8787 -v fleetproxy-home:/home/fleetproxy/.fleetproxy \
  ghcr.io/siedgustavo/fleetproxy:latest

# primer login de provider (persiste en el volumen; device flow, sin binario):
docker run --rm -it -v fleetproxy-home:/home/fleetproxy/.fleetproxy \
  ghcr.io/siedgustavo/fleetproxy:latest bun cli/src/index.ts login github-copilot --local
```

El serve no necesita binario (el core va en `node_modules`); el volumen guarda logins y config entre
reinicios. `--local` loguea con el motor embebido del propio comando; sin `--local`, si hay
`FLEETPROXY_URL` el login va contra ese server por `/auth/*`.

## Monorepo

```
packages/core    → Hono: rutas OpenAI (SSE incremental) + /auth/* (login vía Integration) + bridges:
                    CoreBridge (in-process, @opencode/core vía Engine) y OpencodeBridge (HTTP legado)
packages/fleet   → home/XDG aislado (~/.fleetproxy), resolución del binario (auth legacy), flota (hito 3)
cli              → fleetproxy serve | models | login | auth
scripts/         → get-engine.ts: vendoriza el binario del motor a ./engine (para `auth` local)
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
