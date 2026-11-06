import { describe, expect, test } from "bun:test";
import { OpencodeBridge } from "../src";
import { createApp } from "../src/app";
import { fakeApi } from "./bridge.test";

function makeApp() {
  return createApp({ bridge: new OpencodeBridge(fakeApi()) });
}

describe("GET /v1/models", () => {
  test("expone el catálogo plano de opencode", async () => {
    const res = await makeApp().request("/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Array<{ id: string; owned_by: string }> };
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toContain("github-copilot/gpt-5-mini");
    expect(body.data[0]?.owned_by).toBe("github-copilot");
  });
});

describe("POST /v1/chat/completions", () => {
  test("respuesta no-stream con usage OpenAI", async () => {
    const app = makeApp();
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/echo-1", messages: [{ role: "user", content: "hola fleet" }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: Record<string, number>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]?.message.content).toBe("echo: último turno");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 });
  });

  test("stream=true emite SSE con deltas y [DONE]", async () => {
    const app = makeApp();
    const res = await app.request("/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture", stream: true, messages: [{ role: "user", content: "hola" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const lines = text
      .split("\n\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("data: "));
    expect(lines.at(-1)).toBe("data: [DONE]");
    const deltas = lines
      .slice(0, -1)
      .map((line) => JSON.parse(line.slice("data: ".length)))
      .flatMap((chunk) => (chunk.choices?.[0]?.delta?.content ? [chunk.choices[0].delta.content] : []));
    expect(deltas.join("")).toBe("echo: último turno");
  });

  test("modelo inexistente → 404 model_not_found", async () => {
    const res = await makeApp().request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "nope/nada", messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("model_not_found");
  });

  test("error de opencode → 502 upstream_error", async () => {
    const app = createApp({
      bridge: new OpencodeBridge(fakeApi({ assistantText: "", idleOutcome: "error" })),
    });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/echo-1", messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("outcome");
  });

  test("body inválido → 400", async () => {
    const res = await makeApp().request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fixture/echo-1" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("API key (token de serve)", () => {
  const authed = () => createApp({ bridge: new OpencodeBridge(fakeApi()), apiToken: "sk-test" });

  test("/health sigue abierta (probes del cluster)", async () => {
    expect((await authed().request("/health")).status).toBe(200);
  });

  test("401 sin Authorization en /v1/models, con shape de error OpenAI", async () => {
    const res = await authed().request("/v1/models");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; code: string } };
    expect(body.error.type).toBe("authentication_error");
    expect(body.error.code).toBe("invalid_api_key");
  });

  test("401 con token incorrecto o header que no es Bearer", async () => {
    for (const header of ["Bearer sk-otra", "Basic abc", ""]) {
      const res = await authed().request("/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: header },
        body: JSON.stringify({ model: "fixture/echo-1", messages: [{ role: "user", content: "x" }] }),
      });
      expect(res.status).toBe(401);
    }
  });

  test("200 con Bearer correcto en /v1/models y chat (y alias legacy)", async () => {
    const app = authed();
    const bearer = { authorization: "Bearer sk-test" };
    expect((await app.request("/v1/models", { headers: bearer })).status).toBe(200);
    expect((await app.request("/models", { headers: bearer })).status).toBe(200);
    const chat = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...bearer },
      body: JSON.stringify({ model: "fixture/echo-1", messages: [{ role: "user", content: "x" }] }),
    });
    expect(chat.status).toBe(200);
  });

  test("sin token configurado el server queda abierto", async () => {
    expect((await makeApp().request("/v1/models")).status).toBe(200);
  });
});

describe("proxy de OAuth (/auth/callback)", () => {
  test("sin oauthProxy la ruta no existe", async () => {
    expect((await makeApp().request("/auth/callback?code=x")).status).toBe(404);
  });

  test("reenvía query y method al server de login y devuelve su respuesta", async () => {
    let seen: { url: string; method: string } | null = null;
    const app = createApp({
      bridge: new OpencodeBridge(fakeApi()),
      oauthProxy: async (req) => {
        seen = { url: req.url, method: req.method };
        return new Response("<html>listo</html>", { status: 200, headers: { "content-type": "text/html" } });
      },
    });
    const res = await app.request("/auth/callback?code=abc&state=xyz", { method: "POST", body: "k=v" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>listo</html>");
    expect(seen!.url).toContain("/auth/callback?code=abc&state=xyz");
    expect(seen!.method).toBe("POST");
  });

  test("502 con shape OpenAI cuando no hay ningún login escuchando", async () => {
    const app = createApp({
      bridge: new OpencodeBridge(fakeApi()),
      oauthProxy: async () => {
        throw new TypeError("ECONNREFUSED");
      },
    });
    const res = await app.request("/auth/callback");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string; code: string } };
    expect(body.error.code).toBe("oauth_callback_unavailable");
    expect(body.error.message).toContain("fleetproxy login");
  });
});
