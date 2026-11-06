import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fleetHome, isOpencodeAvailable, memberFromUrl, resolveOpencodeBin, spawnMember, type FleetMember } from "@fleetproxy/fleet";
import { OpencodeApiClient } from "../src/client";
import { OpencodeBridge } from "../src/bridge";
import { createApp } from "../src/app";

// El motor es el opencode-ai empaquetado; el test usa un home temporario para
// no pisar el ~/.fleetproxy real.
const engine = resolveOpencodeBin();
const hasEngine = engine !== undefined && isOpencodeAvailable(engine);
const liveChat = process.env.FLEETPROXY_LIVE_CHAT === "1";
const testHome = join(tmpdir(), `fleetproxy-it-${process.pid}`);

/**
 * Para el chat live: auth de ~/.fleetproxy (logins de fleetproxy, formato del
 * motor empaquetado) si existe; si no, la del opencode del usuario (solo útil
 * si las versiones coinciden).
 */
function seedAuth(home: string): void {
  const candidates = [
    join(fleetHome(), "data", "opencode", "auth.json"),
    join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json"),
  ];
  const source = candidates.find((p) => existsSync(p));
  if (!source) return;
  const target = join(home, "data", "opencode");
  mkdirSync(target, { recursive: true });
  copyFileSync(source, join(target, "auth.json"));
}

describe("integration: motor empaquetado con home aislado", () => {
  let member: FleetMember | undefined;
  let app: ReturnType<typeof createApp> | undefined;

  beforeAll(async () => {
    const url = process.env.FLEETPROXY_OPENCODE_URL;
    if (url) {
      member = memberFromUrl(url);
    } else if (hasEngine) {
      if (liveChat) seedAuth(testHome);
      member = await spawnMember({ home: testHome });
    }
    if (!member) return;
    const client = new OpencodeApiClient({ baseUrl: member.url, password: member.password });
    app = createApp({ bridge: new OpencodeBridge(client) });
  }, 90_000);

  afterAll(async () => {
    await member?.close();
  });

  test.skipIf(!hasEngine)("/v1/models responde con estructura OpenAI", async () => {
    const res = await app!.request("/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
  }, 30_000);

  test.skipIf(!hasEngine)("/health responde ok", async () => {
    const res = await app!.request("/health");
    expect(res.status).toBe(200);
  });

  // Chat real contra un provider autenticado (auth.json copiado desde el perfil
  // del usuario al home temporario). Sin FLEETPROXY_LIVE_MODEL se elige uno del catálogo.
  test.skipIf(!hasEngine || !liveChat)("/v1/chat/completions real", async () => {
    const modelsRes = await app!.request("/v1/models");
    const catalog = (await modelsRes.json()) as { data: Array<{ id: string }> };
    const model =
      process.env.FLEETPROXY_LIVE_MODEL ??
      catalog.data.find((m) => m.id.startsWith("github-copilot/"))?.id ??
      catalog.data[0]?.id;
    expect(model, "catálogo vacío: autenticá un provider (fleetproxy login)").toBeTruthy();

    const res = await app!.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "decí solo OK" }] }),
    });
    const body = (await res.json()) as { choices?: Array<{ message: { content: string } }>; error?: { message: string } };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect((body.choices?.[0]?.message?.content ?? "").length).toBeGreaterThan(0);
  }, 180_000);
});
