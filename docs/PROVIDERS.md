---
layout: default
---

# Providers soportados

fleetproxy no conoce proveedores: expone el catálogo de [opencode](https://opencode.ai) y su
ecosistema de plugins (**[models.dev](https://models.dev)**). Todo lo que soporta el motor lo
soporta fleetproxy; esta página es el mapa de qué hay y cómo se usa cada uno.

```bash
fleetproxy providers            # qué se puede loguear y qué está conectado (métodos + conexiones)
fleetproxy providers --all      # el catálogo completo, sin filtro
GET /auth/providers             # lo mismo por HTTP (bajo el Bearer token)
```

> **El crédito donde es**: el catálogo, los plugins de provider y el OAuth los aporta opencode
> (core + models.dev). Lo nuestro: un único endpoint OpenAI-compatible delante — login headless
> contra el server (aunque esté en el clúster), Bearer token, SSE y una sola llamada al proveedor
> por request.

## Cómo se autentica cada tipo

| Tipo | Cuántos | Cómo se usa |
|---|---|---|
| **OAuth login** | los de la tabla de abajo | `fleetproxy login <provider>` — device flow desde cualquier lado; loopback contra motor local o port-forward ([login](../README.md#login-oauth)) |
| **API key por env** | el resto | definir la variable estándar del provider (`GROQ_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, …) en el proceso de `serve`; sus modelos aparecen solos en `/v1/models` |
| **Free / sin auth** | p. ej. `opencode` (zen) | disponibles siempre |

En Docker/cluster las keys van como env del container (`docker run -e ANTHROPIC_API_KEY=…` /
`env`+Secret en el Deployment). Caso real: `GITLAB_TOKEN` habilita los modelos Duo de gitlab sin
login; sin ese env (y sin login), gitlab aparece en el catálogo pero los requests dan 502.

## Providers con método de auth (se ligan con `fleetproxy login`)

| Provider | Método(s) | Notas |
|---|---|---|
| `github-copilot` | `oauth:device` | device flow, ideal remoto. Enterprise: `--field deploymentType=enterprise --field enterpriseUrl=<dominio>` |
| `opencode` | `oauth:device` | cuenta opencode (los free igual están sin login) |
| `xai` | `oauth:device` | device flow |
| `digitalocean` | `oauth:browser` | listener local `:1456` — login embebido o port-forward |
| `poe` | `oauth:browser` | listener local |
| `snowflake-cortex` | `oauth:browser` | listener local |
| `openai` | `oauth:chatgpt-token-sharing` / `oauth:chatgpt-browser` / `oauth:chatgpt-headless` | `--method` para elegir; browser usa `:1455` |
| `gitlab` | `oauth:pkce` | listener local `:8080`; alternativa: `GITLAB_TOKEN` por env |
| `amazon-bedrock` | `external:aws-profile` | credenciales del server (perfil AWS), no login |
| `google-vertex` | `external:google-adc` | Application Default Credentials del server |
| `claude-agent` | `external:claude-login` | sesión de Claude del server |

> Los `external:*` leen credenciales que ya existen en el server (perfil AWS, ADC, login de
> Claude); no corren el dance por `/auth/login`.

## Catálogo completo

La tabla la mantiene la CI: se regenera contra el catálogo vivo de models.dev
(`bun run docs:providers`, workflow `Providers doc`: semanal + a demanda + al tocar el
generador). `—` en MÉTODOS = provider de API key por env.

<!-- BEGIN providers-catalogo (autogenerado por scripts/gen-providers-doc.ts; no editar a mano) -->

**334 providers** en el catálogo vivo de [models.dev](https://models.dev) (los que tienen
`·` en MÉTODOS se ligan con `fleetproxy login`; el resto toma su API key por env,
p. ej. `GROQ_API_KEY`). Las conexiones activas del server que corre, en vivo:
`fleetproxy providers` o `GET /auth/providers`.

| PROVIDER | MÉTODOS DE AUTH |
|---|---|
| `302ai` | — |
| `abacus` | — |
| `abliteratedllm` | — |
| `abliteration-ai` | — |
| `above` | — |
| `adaption` | — |
| `adzuki` | — |
| `agentrouter` | — |
| `agnes` | — |
| `ai-router` | — |
| `ai21` | — |
| `aiand` | — |
| `aigrow` | — |
| `aihubmix` | — |
| `aimlapi` | — |
| `ainetcafe` | — |
| `aipg` | — |
| `aistupidlevel` | — |
| `aixy` | — |
| `aki-io` | — |
| `alibaba` | — |
| `alibaba-cn` | — |
| `alibaba-coding-plan` | — |
| `alibaba-coding-plan-cn` | — |
| `alibaba-token-plan` | — |
| `alibaba-token-plan-cn` | — |
| `amazon-bedrock` | `external:aws-profile` |
| `ambient` | — |
| `amd` | — |
| `anonrouter` | — |
| `anthropic` | — |
| `anyapi` | — |
| `apiko` | — |
| `arcee` | — |
| `atomic-chat` | — |
| `augure` | — |
| `auriko` | — |
| `autarcho` | — |
| `azure` | `external:azure-cli` |
| `bailing` | — |
| `baseten` | — |
| `bee` | — |
| `berget` | — |
| `blueclaw` | — |
| `bothub` | — |
| `boundless` | — |
| `bumo` | — |
| `butler` | — |
| `byteplus` | — |
| `cedarllm` | — |
| `cerebras` | — |
| `cheapaimodel` | — |
| `cheapest-token` | — |
| `cheapllm` | — |
| `chutes` | — |
| `clarifai` | — |
| `claude-agent` | `external:claude-login` |
| `claudinio` | — |
| `cline-pass` | — |
| `cloudcode` | — |
| `cloudferro-sherlock` | — |
| `cloudflare-ai-gateway` | — |
| `cloudflare-workers-ai` | — |
| `cohere` | — |
| `commandcode` | — |
| `concentrate` | — |
| `confidential-ai` | — |
| `coralbricks` | — |
| `cortecs` | — |
| `crossmodel` | — |
| `crusoe` | — |
| `daoxe` | — |
| `databricks` | — |
| `decisionmodels` | — |
| `deepinfra` | — |
| `deepseek` | — |
| `digitalocean` | `oauth:browser` |
| `dinference` | — |
| `dothoosh` | — |
| `doubleword` | — |
| `drun` | — |
| `ebcloud` | — |
| `echo` | — |
| `edenai` | — |
| `empiriolabs` | — |
| `engy` | — |
| `entrim` | — |
| `evroc` | — |
| `exa` | — |
| `ezkielyna` | — |
| `fastrouter` | — |
| `fiftyx` | — |
| `firecrawl` | — |
| `fireworks-ai` | — |
| `fortytwo` | — |
| `freemodel` | — |
| `frequency` | — |
| `friendli` | — |
| `frogbot` | — |
| `gisoo` | — |
| `github-copilot` | `oauth:device` |
| `gitlab` | `oauth:pkce` |
| `gmicloud` | — |
| `google` | — |
| `google-vertex` | `external:google-adc` |
| `graphn` | — |
| `greenpt` | — |
| `groq` | — |
| `helicone` | — |
| `hetzner` | — |
| `hopper` | — |
| `hostinger-router` | — |
| `hpc-ai` | — |
| `huawei-maas` | — |
| `hubris` | — |
| `huggingface` | — |
| `humain` | — |
| `hyper` | — |
| `impossibl` | — |
| `inception` | — |
| `inceptron` | — |
| `inco` | — |
| `infer` | — |
| `inferall` | — |
| `inference` | — |
| `inference-coop` | — |
| `inferenceapis` | — |
| `inferris` | — |
| `infersia` | — |
| `inferx` | — |
| `infomaniak` | — |
| `io-net` | — |
| `isoquant` | — |
| `iteracompute` | — |
| `jad-ai` | — |
| `jalapeno` | — |
| `jiekou` | — |
| `joingonka` | — |
| `jzstoken` | — |
| `keln` | — |
| `kenari` | — |
| `kilo` | — |
| `kimi-code-plan-cn` | — |
| `kimi-code-plan-global` | — |
| `kitani` | — |
| `klavo` | — |
| `klokintegration` | — |
| `korouter` | — |
| `kosmik` | — |
| `kuae-cloud-coding-plan` | — |
| `kunavo` | — |
| `liquid` | — |
| `lithosai` | — |
| `llmgateway` | — |
| `llmgateway-providers` | — |
| `llmtech` | — |
| `llmtr` | — |
| `lmstudio` | — |
| `logits` | — |
| `longcat` | — |
| `lowrouter` | — |
| `lucidquery` | — |
| `lyceum` | — |
| `lynkr` | — |
| `mallard` | — |
| `meganova` | — |
| `melious` | — |
| `meragpt` | — |
| `merge-gateway` | — |
| `meta` | — |
| `minimax` | — |
| `minimax-cn` | — |
| `minimax-cn-coding-plan` | — |
| `minimax-coding-plan` | — |
| `mistral` | — |
| `mixlayer` | — |
| `moark` | — |
| `modal` | — |
| `model-oracle-ai` | — |
| `modelis` | — |
| `modelscope` | — |
| `modular` | — |
| `moneo` | — |
| `moonshotai` | — |
| `moonshotai-cn` | — |
| `morph` | — |
| `munito` | — |
| `munito-eu` | — |
| `nan` | — |
| `nano-gpt` | — |
| `nearai` | — |
| `nebius` | — |
| `neon` | — |
| `neosmith` | — |
| `neuralwatt` | — |
| `nodecode` | — |
| `nokeep` | — |
| `nova` | — |
| `novita-ai` | — |
| `nvidia` | — |
| `oathbreaker` | — |
| `obscurify` | — |
| `oci` | — |
| `ofox` | — |
| `ollama-cloud` | — |
| `openai` | `oauth:chatgpt-token-sharing` · `oauth:chatgpt-browser` · `oauth:chatgpt-headless` |
| `opencode` | `oauth:device` |
| `opencode-go` | — |
| `openreason` | — |
| `openrouter` | — |
| `opper` | — |
| `orcarouter` | — |
| `outerlabs` | — |
| `ovhcloud` | — |
| `parallel` | — |
| `paraloncloud` | — |
| `pareto` | — |
| `pendra` | — |
| `perplexity` | — |
| `perplexity-agent` | — |
| `phala` | — |
| `phase` | — |
| `pioneer` | — |
| `poe` | `oauth:browser` |
| `poolside` | — |
| `powerspring` | — |
| `primalabs` | — |
| `prime` | — |
| `privatemode-ai` | — |
| `proxystacks` | — |
| `qihang-ai` | — |
| `qiniu-ai` | — |
| `qvac` | — |
| `rayline` | — |
| `reflection` | — |
| `refuseless` | — |
| `regolo-ai` | — |
| `requesty` | — |
| `routing-run` | — |
| `ruapi` | — |
| `runcrate` | — |
| `runinfra` | — |
| `sagg` | — |
| `sakana` | — |
| `salad-cloud` | — |
| `sambanova` | — |
| `sandbase` | — |
| `sap-ai-core` | — |
| `sarvam` | — |
| `scaleway` | — |
| `scnet-token-plan` | — |
| `scx-ai` | — |
| `sensenova` | — |
| `siliconflow` | — |
| `siliconflow-cn` | — |
| `snowflake-cortex` | `oauth:browser` |
| `sokkan` | — |
| `sparrowcodes` | — |
| `stackit` | — |
| `standardcompute` | — |
| `steadyrouter` | — |
| `stepfun` | — |
| `stepfun-ai` | — |
| `stepfun-ai-step-plan` | — |
| `stepfun-step-plan` | — |
| `stepping-stone` | — |
| `subconscious` | — |
| `submodel` | — |
| `superbot-gg` | — |
| `synthetic` | — |
| `synthorai` | — |
| `tavily` | — |
| `teamorouter` | — |
| `teapot-router` | — |
| `tencent-coding-plan` | — |
| `tencent-token-plan` | — |
| `tencent-tokenhub` | — |
| `tensorx` | — |
| `tenstorrent` | — |
| `the-grid-ai` | — |
| `therouter` | — |
| `thinkingmachines` | — |
| `tinfoil` | — |
| `tinyfish` | — |
| `toapis` | — |
| `togetherai` | — |
| `tokengo` | — |
| `tokenify` | — |
| `tokenlab` | — |
| `tokenrouter` | — |
| `tokenwatt` | — |
| `trustedrouter` | — |
| `trustedtokens` | — |
| `turion` | — |
| `typesafe` | — |
| `umans-ai` | — |
| `umans-ai-coding-plan` | — |
| `unbiased` | — |
| `uncensuredai` | — |
| `unorouter` | — |
| `unrestricted` | — |
| `uplinkswitch` | — |
| `upstage` | — |
| `vancine` | — |
| `venice` | — |
| `vercel` | — |
| `verda` | — |
| `vispark` | — |
| `vivgrid` | — |
| `volcengine` | — |
| `volcengine-coding-plan` | — |
| `vultr` | — |
| `wafer.ai` | — |
| `wallaby` | — |
| `wally` | — |
| `wandb` | — |
| `watsonx` | — |
| `watt` | — |
| `xai` | `oauth:device` |
| `xiaomi` | — |
| `xiaomi-token-plan-ams` | — |
| `xiaomi-token-plan-cn` | — |
| `xiaomi-token-plan-sgp` | — |
| `xpersona` | — |
| `xxapi` | — |
| `zai` | — |
| `zai-coding-plan` | — |
| `zeldoc` | — |
| `zenifra` | — |
| `zenmux` | — |
| `zerogpu` | — |
| `zhipuai` | — |
| `zhipuai-coding-plan` | — |
| `zro` | — |

<!-- END providers-catalogo -->
