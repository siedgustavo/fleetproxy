import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isOpencodeAvailable, spawnMember, memberFromUrl, type FleetMember } from "@fleetproxy/fleet";
import { OpencodeApiClient } from "../src/client";
import { OpencodeBridge } from "../src/bridge";
import { createApp } from "../src/app";

// binario en PATH o empaquetado (dependencia opencode-ai de @fleetproxy/fleet)
const hasBinary = isOpencodeAvailable();
const liveChat = process.env.FLEETPROXY_LIVE_CHAT === "1";

describe("integration: opencode serve real", () => {
  let member: FleetMember | undefined;
  let app: ReturnType<typeof createApp> | undefined;

  beforeAll(async () => {
    const url = process.env.FLEETPROXY_OPENCODE_URL;
    member = url ? memberFromUrl(url) : hasBinary ? await spawnMember() : undefined;
    if (!member) return;
    const client = new OpencodeApiClient({ baseUrl: member.url, password: member.password });
    app = createApp({ bridge: new OpencodeBridge(client) });
  }, 90_000);

  afterAll(async () => {
    await member?.close();
  });

  test.skipIf(!hasBinary)("/v1/models responde con estructura OpenAI", async () => {
    const res = await app!.request("/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string }> };
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
  }, 30_000);

  test.skipIf(!hasBinary)("/health responde ok", async () => {
    const res = await app!.request("/health");
    expect(res.status).toBe(200);
  });

  // Chat real contra un provider autenticado: FLEETPROXY_LIVE_CHAT=1 con un
  // modelo disponible (ej: los gratis de opencode o copilot ya logueado).
  const liveModel = process.env.FLEETPROXY_LIVE_MODEL ?? "opencode/crouton-alpha-free";
  test.skipIf(!hasBinary || !liveChat)("/v1/chat/completions real", async () => {
    const res = await app!.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: liveModel, messages: [{ role: "user", content: "decí solo OK" }] }),
    });
    const body = (await res.json()) as { choices?: Array<{ message: { content: string } }>; error?: { message: string } };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect((body.choices?.[0]?.message?.content ?? "").length).toBeGreaterThan(0);
  }, 180_000);
});
