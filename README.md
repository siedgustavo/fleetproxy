# fleetproxy

Proxy **OpenAI-compatible** para aprovechar las suscripciones de **GitHub Copilot** y **GitLab Duo**,
montado sobre [opencode](https://opencode.ai): lo que el TUI para opencode, pero en forma de API.

```
cliente OpenAI ──HTTP──▶ fleetproxy ──@opencode-ai/sdk──▶ opencode serve ──▶ plugins de la comunidad
                          (façade + flota)                 (carga plugins,      (auth OAuth,
                                                            auth store, config)  proveedores)
```

- **Los módulos son los plugins de opencode**: los escribe/mantiene la comunidad y los carga opencode en su runtime. fleetproxy no agrega código de proveedores: agrega la façade OpenAI y la orquestación de la flota.
- **Flota**: para aprovechar N cuentas de una suscripción, se corren N instancias de opencode (perfiles separados) y fleetproxy rota los requests.

## Quickstart

```bash
bun install
bun run dev          # spawnea `opencode serve` y expone http://localhost:8787

curl http://localhost:8787/v1/models

curl http://localhost:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model": "github-copilot/gpt-5-mini", "messages": [{"role": "user", "content": "hola"}]}'
```

> Los modelos aparecen una vez que opencode tenga algún provider autenticado (ej: `opencode auth login` → GitHub Copilot).

### Config (`fleetproxy.json`, opcional)

```json
{
  "port": 8787,
  "opencode": { "url": "http://127.0.0.1:4096" }
}
```

Sin `opencode.url`, `fleetproxy serve` spawnea su propio `opencode serve` (requiere el binario `opencode` en PATH).

## Monorepo

| Paquete | Rol |
| --- | --- |
| `packages/core` | HTTP OpenAI-compatible (Hono) + puente hacia la API de server de opencode |
| `packages/fleet` | Supervisor de instancias opencode (spawn/attach, perfiles, rotación) |
| `cli` | `fleetproxy serve \| models \| login` |

## Scripts

```bash
bun test        # unit (fake client) + integración contra opencode serve
bun run typecheck
```

## Roadmap corto

1. ✅ Façade `/v1/models` + `/v1/chat/completions` sobre opencode
2. Copilot E2E (`fleetproxy login copilot`)
3. Flota multi-cuenta (round-robin + cooldown)
4. GitLab Duo vía opencode (nativo o plugin `opencode-gitlab-duo`)
5. CLI/config completos + sesiones persistentes
6. CI + releases (binario `bun compile`, Docker con opencode incluido)
