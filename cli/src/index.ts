#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, OpencodeApiClient, OpencodeBridge } from "@fleetproxy/core";
import { memberFromUrl, spawnMember, type FleetMember } from "@fleetproxy/fleet";

interface Config {
  port?: number;
  opencode?: { url?: string };
}

const usage = `fleetproxy — façade OpenAI-compatible sobre opencode

Uso:
  fleetproxy serve [--port <n>]   Levanta el proxy (config: fleetproxy.json)
  fleetproxy models               Lista modelos del opencode conectado
  fleetproxy login <provider>     (próximo hito) delega al auth login de opencode

Config (fleetproxy.json, opcional):
  { "port": 8787, "opencode": { "url": "http://127.0.0.1:4096" } }
  Sin "opencode.url" se spawnea un "opencode serve" local (binario en PATH).
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
    if (models.length === 0) console.log("(sin modelos: conectate a opencode con algún provider autenticado)");
    if (spawned) await member.close();
    return;
  }

  if (command === "login") {
    console.log("fleetproxy login <provider>: todavía no implementado (hito 2).");
    console.log("Por ahora usá: opencode auth login");
    return;
  }

  console.log(usage);
}

await main();
