/**
 * Descarga el binario del motor (release de GitHub de opencode) a ./engine,
 * la ruta que `resolveOpencodeBin` prioriza (packages/fleet: vendoredOpencodeBin).
 *
 * ¿Por qué?: el paquete npm `opencode-ai` sigue en 1.19.5 y su storage/auth NO
 * es compatible con los homes que escribe lee @opencode/core 2.x. `fleetproxy
 * login` necesita un binario de la MISMA línea que el core (2.2.6) para escribir
 * credenciales que el serve in-process entienda. En Docker ya se vendoriza en
 * la build; esto es el equivalente para desarrollo local.
 *
 * Uso: bun scripts/get-engine.ts   (override: OPENCODE_ENGINE_VERSION=2.2.7)
 */
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "bun";

const version = process.env.OPENCODE_ENGINE_VERSION ?? "2.2.6";
const os = { linux: "linux", darwin: "darwin", win32: "windows" }[process.platform];
const arch = { x64: "x64", arm64: "arm64" }[process.arch];
if (!os || !arch) throw new Error(`plataforma no soportada: ${process.platform}/${process.arch}`);

const asset = os === "windows" ? `opencode-${os}-${arch}.zip` : `opencode-${os}-${arch}.tar.gz`;
const url = `https://github.com/anomalyco/opencode/releases/download/v${version}/${asset}`;
const dir = new URL("../engine/", import.meta.url).pathname;
await mkdir(dir, { recursive: true });

const res = await fetch(url);
if (!res.ok) throw new Error(`fallo descargando ${asset} v${version}: HTTP ${res.status}`);
const bin = join(dir, os === "windows" ? "opencode.exe" : "opencode");
if (asset.endsWith(".zip")) {
  const tmp = join(dir, "engine.zip");
  await Bun.write(tmp, res);
  const unzip = spawn(["unzip", "-o", tmp, "-d", dir]);
  if (await unzip.exited !== 0) throw new Error("fallo descomprimiendo engine.zip (¿falta unzip?)");
  await rm(tmp);
} else {
  const tmp = join(dir, "engine.tar.gz");
  await Bun.write(tmp, res);
  const untar = spawn(["tar", "-xzf", tmp, "-C", dir]);
  if (await untar.exited !== 0) throw new Error("fallo descomprimiendo engine.tar.gz");
  await rm(tmp);
}
await chmod(bin, 0o755);
const ver = Bun.spawnSync([bin, "--version"], { cwd: dir });
console.log(`engine: ${bin}\nversion: ${ver.stdout.toString().trim()}`);
