import { describe, expect, test } from "bun:test";
import { OpencodeBridge } from "../src";
import { createApp } from "../src/app";
import { LoginError } from "../src/engine";
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

describe("POST /v1/chat/completions stream=true (deltas incremental)", () => {
  // Bridge minimal que emite varios deltas por onDelta.
  const streamingBridge = {
    async catalog() {
      return [{ id: "fix/m", providerID: "fix", modelID: "m" }];
    },
    async chat() {
      return { text: "hola mundo", usage: { input: 1, output: 2, total: 3 } };
    },
    async stream(_params: never, onDelta?: (d: string) => void) {
      onDelta?.("hola ");
      onDelta?.("mundo");
      return { text: "hola mundo", usage: { input: 1, output: 2, total: 3 } };
    },
  };

  test("cada delta sale en su chunk y el usage va al final", async () => {
    const app = createApp({ bridge: streamingBridge as never });
    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "fix/m", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"));
    const contents = dataLines
      .map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content)
      .filter((c) => typeof c === "string");
    expect(contents).toEqual(["hola ", "mundo"]); // un chunk por delta, no uno solo
    expect(dataLines.some((l) => l.includes('"usage"'))).toBe(true);
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });
});

describe("login OAuth in-process (/auth/*)", () => {
  interface FakeAuthState {
    pending: boolean;
    completeError?: Error;
    recorder: string[];
  }
  const makeAuth = (state: FakeAuthState) => ({
    async login(provider: string, method?: string, answer?: Record<string, string>) {
      state.recorder.push(`login:${provider}:${method ?? "-"}`);
      if (provider === "desconocido") throw new LoginError("provider-not-found", `provider desconocido: ${provider}`);
      if (provider === "sin_metodo") throw new LoginError("no-oauth-method", "gitlab no tiene método oauth");
      if (provider === "pide_form") throw new LoginError("form-required", "faltan campos: domain (pasalos con answer/--field)");
      return {
        provider,
        method: method ?? "device",
        attemptID: "att-9",
        url: "https://github.com/login/device",
        instructions: "Enter code: WXYZ",
        mode: "auto" as const,
        answer: answer ?? { deploymentType: "github.com" },
      };
    },
    async loginStatus() {
      return state.pending ? { status: "pending" as const } : { status: "complete" as const };
    },
    async loginComplete(_provider: string, attemptID: string) {
      if (state.completeError) throw state.completeError;
      state.recorder.push(`complete:${attemptID}`);
      state.pending = false;
    },
    async loginCancel() {
      state.recorder.push("cancel");
    },
    async providers() {
      return [
        {
          id: "github-copilot",
          name: "GitHub Copilot",
          methods: [{ id: "device", type: "oauth" }],
          connections: [{ type: "credential", label: "GitHub Copilot" }],
        },
      ];
    },
  });

  const makeAuthApp = (state: FakeAuthState, apiToken?: string) =>
    createApp({ bridge: new OpencodeBridge(fakeApi()), apiToken, auth: makeAuth(state) });

  test("sin `auth` las rutas de login no existen", async () => {
    expect((await makeApp().request("/auth/login", { method: "POST" })).status).toBe(404);
    expect((await makeApp().request("/auth/callback")).status).toBe(404);
    expect((await makeApp().request("/auth/providers")).status).toBe(404);
  });

  test("GET /auth/providers lista métodos y conexiones (bajo token)", async () => {
    const state: FakeAuthState = { pending: true, recorder: [] };
    const app = makeAuthApp(state, "sk-test");
    expect((await app.request("/auth/providers")).status).toBe(401);
    const res = await app.request("/auth/providers", { headers: { authorization: "Bearer sk-test" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; methods: unknown[]; connections: unknown[] }>;
    expect(body[0]?.id).toBe("github-copilot");
    expect(body[0]?.methods[0]).toEqual({ id: "device", type: "oauth" });
    expect(body[0]?.connections[0]).toEqual({ type: "credential", label: "GitHub Copilot" });
  });

  test("POST /auth/login inicia el attempt y devuelve url + instrucciones", async () => {
    const state: FakeAuthState = { pending: true, recorder: [] };
    const res = await makeAuthApp(state).request("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github-copilot", method: "device" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      provider: "github-copilot",
      method: "device",
      attemptID: "att-9",
      url: "https://github.com/login/device",
      instructions: "Enter code: WXYZ",
      mode: "auto",
      answer: { deploymentType: "github.com" },
    });
    expect(state.recorder).toEqual(["login:github-copilot:device"]);
  });

  test("provider faltante → 400; desconocido → 404; sin método → 400; form requerido → 400", async () => {
    const state: FakeAuthState = { pending: true, recorder: [] };
    const app = makeAuthApp(state);
    const post = (body: unknown) =>
      app.request("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({})).status).toBe(400);
    const notFound = await post({ provider: "desconocido" });
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as { error: { code: string } }).error.code).toBe("provider-not-found");
    expect((await post({ provider: "sin_metodo" })).status).toBe(400);
    const formRequired = await post({ provider: "pide_form" });
    expect(formRequired.status).toBe(400);
    expect(((await formRequired.json()) as { error: { code: string } }).error.code).toBe("form-required");
  });

  test("status, complete y cancel del attempt", async () => {
    const state: FakeAuthState = { pending: true, recorder: [] };
    const app = makeAuthApp(state);
    const status = await app.request("/auth/login/att-9?provider=github-copilot");
    expect(await status.json()).toEqual({ attemptID: "att-9", status: "pending" });
    const done = await app.request("/auth/login/att-9/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "github-copilot", code: "CODE" }),
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ attemptID: "att-9", status: "complete" });
    expect((await app.request("/auth/login/att-9?provider=github-copilot", { method: "DELETE" })).status).toBe(200);
    expect(state.recorder).toEqual(["complete:att-9", "cancel"]);
    // attempt inexistente (LoginError attempt-not-found) → 404
    const state2: FakeAuthState = {
      pending: true,
      recorder: [],
      completeError: new LoginError("attempt-not-found", "intent inexistente"),
    };
    const notFound = await makeAuthApp(state2).request("/auth/login/otro/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "x" }),
    });
    expect(notFound.status).toBe(404);
    expect(((await notFound.json()) as { error: { code: string } }).error.code).toBe("attempt-not-found");
  });

  test("bajo token: /auth/login exige Bearer pero /auth/callback no", async () => {
    const state: FakeAuthState = { pending: true, recorder: [] };
    const app = makeAuthApp(state, "sk-test");
    expect((await app.request("/auth/login", { method: "POST", body: "{}" })).status).toBe(401);
    expect(
      (
        await app.request("/auth/login/att-9?provider=x", { headers: { authorization: "Bearer sk-test" } })
      ).status,
    ).toBe(200);
    expect((await app.request("/auth/callback?provider=x&attempt=att-9&code=K")).status).toBe(200);
  });

  test("GET /auth/callback completa con el code y devuelve HTML; faltan params → 400", async () => {
    const state: FakeAuthState = { pending: true, recorder: [] };
    const app = makeAuthApp(state);
    const res = await app.request("/auth/callback?provider=gitlab&attempt=att-9&code=THECODE");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Login completado");
    expect(state.recorder).toEqual(["complete:att-9"]);
    expect((await app.request("/auth/callback")).status).toBe(400);
  });

  test("/auth/callback sobre un attempt auto que ya se resuelve solo no rompe", async () => {
    const state: FakeAuthState = { pending: true, recorder: [], completeError: new Error("OAuth attempt already completing: att-9") };
    const res = await makeAuthApp(state).request("/auth/callback?provider=x&attempt=att-9&code=K");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Login en curso");
  });
});
