import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { EngineLoginAttempt } from "@fleetproxy/core";
import { loginRemoteApi, parseLoginArgs, runLoginFlow } from "../src/index";

const attempt: EngineLoginAttempt = {
  provider: "github-copilot",
  method: "device",
  attemptID: "att-1",
  url: "https://github.com/login/device",
  instructions: "Enter code: ABCD-1234",
  mode: "auto",
  answer: { deploymentType: "github.com" },
};

describe("parseLoginArgs", () => {
  test("provider con defaults (300s, embebido si no hay url)", () => {
    const flags = parseLoginArgs(["github-copilot"]);
    expect(flags?.provider).toBe("github-copilot");
    expect(flags?.timeoutMs).toBe(300_000);
    expect(flags?.local).toBe(false);
    expect(flags?.method).toBeUndefined();
  });

  test("flags de valor y booleanos", () => {
    const flags = parseLoginArgs([
      "gitlab",
      "--method",
      "oauth",
      "--url",
      "http://127.0.0.1:18787",
      "--token",
      "sk-t",
      "--timeout",
      "60",
      "--local",
      "--no-open",
    ]);
    expect(flags).toEqual({
      provider: "gitlab",
      method: "oauth",
      url: "http://127.0.0.1:18787",
      token: "sk-t",
      timeoutMs: 60_000,
      local: true,
      noOpen: true,
      fields: {},
    });
  });

  test("--field repetible alimenta el answer del form", () => {
    const flags = parseLoginArgs([
      "github-copilot",
      "--field",
      "deploymentType=enterprise",
      "--field",
      "enterpriseUrl=acme.ghe.com",
    ]);
    expect(flags?.fields).toEqual({ deploymentType: "enterprise", enterpriseUrl: "acme.ghe.com" });
  });

  test("sin provider no hay flags (el comando pide uso)", () => {
    expect(parseLoginArgs(["--timeout", "10"])).toBeUndefined();
    expect(parseLoginArgs([])).toBeUndefined();
  });
});

describe("loginRemoteApi (cliente HTTP de /auth/*)", () => {
  function stubServer(log: string[]) {
    const app = new Hono();
    app.post("/auth/login", async (c) => {
      const body = await c.req.json();
      log.push(`connect:${body.provider}:${body.method ?? "-"}`);
      if (body.provider === "desconocido") return c.json({ error: { message: "provider desconocido" } }, 404);
      return c.json(attempt);
    });
    app.get("/auth/login/:attempt", (c) => {
      log.push(`status:${c.req.param("attempt")}:${c.req.query("provider")}`);
      return c.json({ attemptID: c.req.param("attempt"), status: "pending" });
    });
    app.post("/auth/login/:attempt/complete", async (c) => {
      const body = await c.req.json();
      log.push(`complete:${body.code ?? "-"}`);
      return c.json({ attemptID: c.req.param("attempt"), status: "complete" });
    });
    app.delete("/auth/login/:attempt", (c) => {
      log.push(`cancel:${c.req.param("attempt")}:${c.req.query("provider")}`);
      return c.json({ ok: true });
    });
    const server = Bun.serve({ port: 0, fetch: app.fetch });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop() };
  }

  test("login + status por la API, con token", async () => {
    const log: string[] = [];
    const stub = stubServer(log);
    try {
      const api = loginRemoteApi(stub.url, "sk-test");
      const got = await api.login("github-copilot");
      expect(got).toEqual(attempt);
      const status = await api.loginStatus("github-copilot", "att-1");
      expect(status.status).toBe("pending");
      await api.loginComplete("github-copilot", "att-1", "CODE");
      await api.loginCancel("github-copilot", "att-1");
      expect(log).toEqual(["connect:github-copilot:-", "status:att-1:github-copilot", "complete:CODE", "cancel:att-1:github-copilot"]);
    } finally {
      stub.stop();
    }
  });

  test("error HTTP se propaga con el message del proxy", async () => {
    const log: string[] = [];
    const stub = stubServer(log);
    try {
      const api = loginRemoteApi(stub.url);
      await expect(api.login("desconocido")).rejects.toThrow("provider desconocido");
    } finally {
      stub.stop();
    }
  });
});

describe("runLoginFlow (polling del attempt)", () => {
  const scriptedApi = (statuses: Array<{ status: string; message?: string }>, recorder: string[]) => ({
    async loginStatus() {
      recorder.push("status");
      return statuses.shift() as never;
    },
    async loginCancel() {
      recorder.push("cancel");
    },
  });

  test("resuelve cuando el attempt completa", async () => {
    const calls: string[] = [];
    const api = scriptedApi([{ status: "pending" }, { status: "pending" }, { status: "complete" }], calls);
    await runLoginFlow(attempt, api, { timeoutMs: 5_000, pollMs: 1 });
    expect(calls).toEqual(["status", "status", "status"]);
  });

  test("failed propaga el mensaje del provider", async () => {
    const calls: string[] = [];
    const api = scriptedApi([{ status: "failed", message: "User denied the request" }], calls);
    await expect(runLoginFlow(attempt, api, { timeoutMs: 5_000, pollMs: 1 })).rejects.toThrow("User denied");
  });

  test("expira y cancela si pasa el timeout", async () => {
    const calls: string[] = [];
    const api = {
      async loginStatus() {
        calls.push("status");
        return { status: "pending" as const };
      },
      async loginCancel() {
        calls.push("cancel");
      },
    };
    await expect(runLoginFlow(attempt, api, { timeoutMs: 20, pollMs: 2 })).rejects.toThrow("sin completar");
    expect(calls[calls.length - 1]).toBe("cancel");
  });
});
