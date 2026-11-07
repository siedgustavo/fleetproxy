import { Hono, type Context } from "hono";
import { ModelNotFoundError, UpstreamError, type Bridge, type ChatResult } from "./bridge";
import { LoginError, type Engine } from "./engine";

/** Superficie de login OAuth del motor (Engine es la implementación real). */
export type AuthApi = Pick<Engine, "login" | "loginStatus" | "loginComplete" | "loginCancel" | "providers">;

export interface CreateAppOptions {
  bridge: Bridge;
  /**
   * API key estilo OpenAI: si está definida, toda ruta /v1/* (y los alias
   * legacy) exige `Authorization: Bearer <token>`; sin definir, el server es
   * abierto (dev local). /health queda siempre abierta (probes del cluster).
   */
  apiToken?: string;
  /**
   * Login OAuth in-process (Integration.Service del motor). Define /auth/login*
   * (bajo el token) y /auth/callback (GET, para el browser: la seguridad del
   * flujo la dan state+PKCE del provider). Sin `auth` las rutas no existen.
   */
  auth?: AuthApi;
}

function openAIError(message: string, type = "invalid_request_error", code?: string) {
  return { error: { message, type, param: null, code: code ?? null } } as const;
}

/** Comparación en tiempo constante para no filtrar el token por timing. */
function timingSafeEquals(a: string, b: string): boolean {
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i += 1) diff |= ba[i]! ^ bb[i]!;
  return diff === 0;
}

function usageOf(result: ChatResult) {
  return {
    prompt_tokens: result.usage.input,
    completion_tokens: result.usage.output,
    total_tokens: result.usage.total,
  };
}

/** Mapea LoginError del motor a un HTTP status con shape OpenAI. */
function loginErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof LoginError) {
    const type = error.kind === "authorization-failed" ? "api_error" : "invalid_request_error";
    const status =
      error.kind === "provider-not-found" || error.kind === "attempt-not-found"
        ? 404
        : error.kind === "authorization-failed"
          ? 502
          : 400;
    return c.json(openAIError(error.message, type, error.kind), status);
  }
  throw error;
}

function loginPage(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>fleetproxy · ${title}</title>
<body style="font-family:system-ui;margin:4rem auto;max-width:32rem;text-align:center">
<h1>${title}</h1><p>${body}</p></body>`;
}

/**
 * SSE incremental: si el bridge puede streamear, emite cada delta apenas llega
 * (role → deltas… → finish → usage → [DONE]); si no, manda el texto de una.
 */
function sseResponse(params: {
  id: string;
  created: number;
  model: string;
  run: (onDelta: (delta: string) => void) => Promise<ChatResult>;
}): Response {
  const { id, created, model, run } = params;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      const chunk = (delta: Record<string, unknown>, finish: string | null, extra?: Record<string, unknown>) =>
        send({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...extra,
        });
      chunk({ role: "assistant" }, null);
      let sawDelta = false;
      try {
        const chat = await run((delta) => {
          if (!delta) return;
          sawDelta = true;
          chunk({ content: delta }, null);
        });
        if (!sawDelta && chat.text) chunk({ content: chat.text }, null);
        chunk({}, "stop");
        chunk({}, "stop", { usage: usageOf(chat) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send({ error: { message, type: "upstream_error", param: null, code: null } });
      } finally {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export function createApp({ bridge, apiToken, auth }: CreateAppOptions): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  const requireToken = async (c: Context, next: () => Promise<void>) => {
    if (!apiToken) return next();
    const header = c.req.header("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (presented && timingSafeEquals(presented, apiToken)) return next();
    return c.json(openAIError("No API key provided (usá Authorization: Bearer <token>)", "authentication_error", "invalid_api_key"), 401);
  };
  app.use("/v1/*", requireToken);
  app.use("/models", requireToken);
  app.use("/chat/completions", requireToken);

  if (auth) {
    app.use("/auth/login", requireToken);
    app.use("/auth/login/*", requireToken);
    app.use("/auth/providers", requireToken);

    // Proveedores de auth registrados: métodos disponibles y conexiones activas.
    app.get("/auth/providers", async (c) => {
      return c.json(await auth.providers());
    });

    // El browser no trae el Bearer: /auth/callback va fuera del token.
    const bodyProvider = (body: Record<string, unknown> | null): string =>
      typeof body?.provider === "string" ? body.provider : "";

    app.post("/auth/login", async (c) => {
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      const provider = bodyProvider(body);
      if (!provider) return c.json(openAIError("Se requiere 'provider' en el body (p. ej. \"github-copilot\")"), 400);
      const answer =
        body?.answer !== null && typeof body?.answer === "object"
          ? Object.fromEntries(Object.entries(body.answer as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
          : undefined;
      try {
        return c.json(
          await auth.login(provider, typeof body?.method === "string" ? body.method : undefined, answer),
        );
      } catch (error) {
        return loginErrorResponse(c, error);
      }
    });

    app.get("/auth/login/:attempt", async (c) => {
      const provider = c.req.query("provider") ?? "";
      const attempt = c.req.param("attempt") ?? "";
      if (!provider) return c.json(openAIError("Falta el query 'provider'"), 400);
      try {
        return c.json({ attemptID: attempt, ...(await auth.loginStatus(provider, attempt)) });
      } catch (error) {
        return loginErrorResponse(c, error);
      }
    });

    app.post("/auth/login/:attempt/complete", async (c) => {
      const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
      const provider = bodyProvider(body);
      const attempt = c.req.param("attempt") ?? "";
      if (!provider) return c.json(openAIError("Se requiere 'provider' en el body"), 400);
      try {
        await auth.loginComplete(provider, attempt, typeof body?.code === "string" ? body.code : undefined);
        return c.json({ attemptID: attempt, ...(await auth.loginStatus(provider, attempt)) });
      } catch (error) {
        return loginErrorResponse(c, error);
      }
    });

    app.delete("/auth/login/:attempt", async (c) => {
      const provider = c.req.query("provider") ?? "";
      const attempt = c.req.param("attempt") ?? "";
      if (!provider) return c.json(openAIError("Falta el query 'provider'"), 400);
      try {
        await auth.loginCancel(provider, attempt);
        return c.json({ ok: true });
      } catch (error) {
        return loginErrorResponse(c, error);
      }
    });

    // Redirect del browser para flujos code/PKCE (o para pegar la URL del
    // redirect cuando el listener loopback del provider no es alcanzable).
    app.get("/auth/callback", async (c) => {
      const provider = c.req.query("provider") ?? "";
      const attempt = c.req.query("attempt") ?? "";
      const code = c.req.query("code") ?? "";
      if (!provider || !attempt) return c.json(openAIError("Faltan los query 'provider' y 'attempt'"), 400);
      try {
        await auth.loginComplete(provider, attempt, code || undefined);
        return c.html(loginPage("Login completado", `Podés cerrar esta pestaña (${provider}).`));
      } catch (error) {
        // Un attempt "auto" ya puede estar resolviendo solo (polling/listener).
        if (error instanceof Error && /already completing/i.test(error.message)) {
          return c.html(loginPage("Login en curso", `El attempt ya estaba resolviendo solo (${provider}).`));
        }
        return loginErrorResponse(c, error);
      }
    });
  }

  const modelsHandler = async (c: Context) => {
    const models = await bridge.catalog();
    return c.json({
      object: "list",
      data: models.map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.providerID })),
    });
  };
  app.get("/v1/models", modelsHandler);
  app.get("/models", modelsHandler);

  const handler = async (c: Context) => {
    const body = await c.req
      .json()
      .catch(() => null)
      .then((value) => (value ?? null) as Record<string, unknown> | null);
    if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) {
      return c.json(openAIError("Se requiere un body JSON con 'model' (string) y 'messages' (array)"), 400);
    }

    const request = { model: body.model, messages: body.messages as never };
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    try {
      if (body.stream === true) {
        return sseResponse({
          id,
          created,
          model: body.model,
          run: (onDelta) => (bridge.stream ? bridge.stream(request, onDelta) : bridge.chat(request)),
        });
      }
      const chat = await bridge.chat(request);
      return c.json({
        id,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: chat.text },
            logprobs: null,
            finish_reason: "stop",
          },
        ],
        usage: usageOf(chat),
      });
    } catch (error) {
      if (error instanceof ModelNotFoundError) {
        return c.json(openAIError(error.message, "invalid_request_error", "model_not_found"), 404);
      }
      if (error instanceof UpstreamError) {
        return c.json(openAIError(error.message, "api_error", "upstream_error"), 502);
      }
      throw error;
    }
  };

  app.post("/v1/chat/completions", handler);
  app.post("/chat/completions", handler);

  return app;
}
