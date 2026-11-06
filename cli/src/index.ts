#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, OpencodeApiClient, OpencodeBridge } from "@fleetproxy/core";
import {
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
  opencode?: { url?: string };
}

const usage = `fleetproxy — façade OpenAI-compatible sobre opencode

Uso:
  fleetproxy serve [--port <n>]   Levanta el proxy (config: fleetproxy.json)
  fleetproxy models               Lista modelos del motor conectado
  fleetproxy login [provider...]  Login de providers (motor empaquetado, home ~/.fleetproxy)

Config (fleetproxy.json, opcional):
  { "port": 8787, "opencode": { "url": "http://127.0.0.1:4096" } }
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
    const { member, spawned } = await attachOrSpawn(config);
    const bridge = bridgeFor(member);
    const app = createApp({ bridge });
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
