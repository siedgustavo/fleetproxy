import { Hono, type Context } from "hono";
import { ModelNotFoundError, UpstreamError, type Bridge, type ChatResult } from "./bridge";

export interface CreateAppOptions {
  bridge: Bridge;
  /**
   * API key estilo OpenAI: si está definida, toda ruta /v1/* (y los alias
   * legacy) exige `Authorization: Bearer <token>`; sin definir, el server es
   * abierto (dev local). /health queda siempre abierta (probes del cluster).
   */
  apiToken?: string;
  /**
   * Proxy del callback OAuth (deploy headless): recibe /auth/callback del
   * browser y lo reenvía al proceso de login del motor (127.0.0.1:<puerto
   * fijo>). Sin proxy definido la ruta no existe. No va tras el token:
   * la seguridad del flujo la dan state+PKCE del provider.
   */
  oauthProxy?: (req: Request) => Promise<Response>;
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

export function createApp({ bridge, apiToken, oauthProxy }: CreateAppOptions): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

  if (oauthProxy) {
    app.all("/auth/callback", async (c) => {
      try {
        return await oauthProxy(c.req.raw);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return c.json(
          openAIError(
            `OAuth callback sin destino (${msg}). ¿Hay un "fleetproxy login <provider>" esperando en el callbackPort?`,
            "api_error",
            "oauth_callback_unavailable",
          ),
          502,
        );
      }
    });
  }

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
