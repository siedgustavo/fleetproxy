#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, OpencodeApiClient, OpencodeBridge } from "@fleetproxy/core";
import {
  applyOauthEngineConfig,
  fleetEnv,
  fleetHome,
  isOpencodeAvailable,
  memberFromUrl,
  resolveOpencodeBin,
  spawnMember,
  type FleetMember,
} from "@fleetproxy/fleet";

interface Config {
  port?: number;
  /** API key que exijen las rutas /v1/* (también por env FLEETPROXY_TOKEN) */
  token?: string;
  /** URL pública de la app; habilita el proxy de /auth/callback (env FLEETPROXY_URL) */
  url?: string;
  /** OAuth headless: qué providers reciben callbackPort/redirectUri y en qué puerto fijo */
  oauth?: { providers?: string[]; callbackPort?: number };
  opencode?: { url?: string };
}

const DEFAULT_OAUTH_PROVIDERS = ["gitlab", "digitalocean"];
const DEFAULT_OAUTH_PORT = 19_821;

const usage = `fleetproxy — façade OpenAI-compatible sobre opencode

Uso:
  fleetproxy serve [--port <n>]   Levanta el proxy (config: fleetproxy.json)
  fleetproxy models               Lista modelos del motor conectado
  fleetproxy login [provider...]  Login de providers (motor empaquetado, home ~/.fleetproxy)

Config (fleetproxy.json, opcional):
  { "port": 8787, "token": "sk-…", "url": "https://…",
    "oauth": { "providers": ["gitlab"], "callbackPort": 19821 },
    "opencode": { "url": "http://127.0.0.1:4096" } }
  Con "token" (o env FLEETPROXY_TOKEN) las rutas /v1/* exigen
  Authorization: Bearer <token>; /health queda abierta.
  Con "url" (o env FLEETPROXY_URL) el OAuth del motor vuelve a <url>/auth/callback
  (proxy al callbackPort fijo del login) — necesario en Docker/cluster headless.
  Sin "opencode.url" se spawnea el motor empaquetado (opencode-ai); sus datos,
  logins y config quedan aislados en ~/.fleetproxy (no tocan tu opencode del sistema).
`;

function loadConfig(): Config {
  const path = join(process.cwd(), "fleetproxy.json");
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Config;
}

async function attachOrSpawn(config: Config): Promise<{ member: FleetMember; spawned: boolean }> {
  const url = config.opencode?.url ?? process.env.FLEETPROXY_OPENCODE_URL;
  if (url) return { member: memberFromUrl(url), spawned: false };
  return { member: await spawnMember(), spawned: true };
}

function bridgeFor(member: FleetMember): OpencodeBridge {
  return new OpencodeBridge(new OpencodeApiClient({ baseUrl: member.url, password: member.password }));
}

function parsePort(argv: string[], config: Config): number {
  const flag = argv.indexOf("--port");
  if (flag >= 0 && argv[flag + 1]) return Number(argv[flag + 1]);
  if (process.env.FLEETPROXY_PORT) return Number(process.env.FLEETPROXY_PORT);
  return config.port ?? 8787;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? "help";
  const config = loadConfig();

  if (command === "serve") {
    const port = parsePort(argv, config);
    const publicUrl = (process.env.FLEETPROXY_URL ?? config.url ?? "").replace(/\/$/, "");
    const callbackPort = Number(process.env.FLEETPROXY_OAUTH_PORT ?? config.oauth?.callbackPort ?? DEFAULT_OAUTH_PORT);
    if (publicUrl) {
      // El browser vuelve a <url pública>/auth/callback; fleetproxy la reenvía
      // al server efímero del login (127.0.0.1:<callbackPort>).
      applyOauthEngineConfig({
        providers: config.oauth?.providers ?? DEFAULT_OAUTH_PROVIDERS,
        callbackPort,
        redirectUri: `${publicUrl}/auth/callback`,
      });
    }
    const oauthProxy = publicUrl
      ? async (req: Request): Promise<Response> => {
          const u = new URL(req.url);
          return fetch(`http://127.0.0.1:${callbackPort}${u.pathname}${u.search}`, { headers: req.headers });
        }
      : undefined;
    const { member, spawned } = await attachOrSpawn(config);
    const bridge = bridgeFor(member);
    const app = createApp({ bridge, apiToken: process.env.FLEETPROXY_TOKEN ?? config.token, oauthProxy });
    const server = Bun.serve({ port, fetch: app.fetch });
    const models = await bridge.catalog().catch(() => []);
    console.log(`fleetproxy escuchando en http://localhost:${server.port}`);
    console.log(`  opencode: ${member.url}${spawned ? " (spawn)" : " (attach)"}`);
    console.log(`  modelos:  ${models.length}`);
    return;
  }

  if (command === "models") {
    const { member, spawned } = await attachOrSpawn(config);
    const bridge = bridgeFor(member);
    const models = await bridge.catalog();
    for (const model of models) console.log(model.id);
    if (models.length === 0) console.log("(sin modelos: corré `fleetproxy login` para autenticar un provider)");
    if (spawned) await member.close();
    return;
  }

  if (command === "login") {
    const bin = resolveOpencodeBin();
    if (!bin || !isOpencodeAvailable(bin)) {
      console.error("fleetproxy: motor opencode no disponible (reinstalá las dependencias de fleetproxy).");
      process.exit(1);
    }
    const home = fleetHome();
    for (const dir of Object.values(fleetEnv(home))) mkdirSync(dir, { recursive: true });
    // Con URL pública configurada, el authorize sale con redirect a la app y
    // el server efímero del login escucha en el callbackPort fijo.
    const loginPublicUrl = (process.env.FLEETPROXY_URL ?? config.url ?? "").replace(/\/$/, "");
    if (loginPublicUrl) {
      applyOauthEngineConfig({
        providers: config.oauth?.providers ?? DEFAULT_OAUTH_PROVIDERS,
        callbackPort: Number(process.env.FLEETPROXY_OAUTH_PORT ?? config.oauth?.callbackPort ?? DEFAULT_OAUTH_PORT),
        redirectUri: `${loginPublicUrl}/auth/callback`,
      });
    }
    const proc = Bun.spawn([bin, "auth", "login", ...argv.slice(1)], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, ...fleetEnv(home) } as Record<string, string>,
    });
    const code = await proc.exited;
    if (code !== 0) process.exit(code ?? 1);
    return;
  }

  console.log(usage);
}

try {
  await main();
} catch (error) {
  console.error(`fleetproxy: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
