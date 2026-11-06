import { Hono, type Context } from "hono";
import { ModelNotFoundError, OpencodeBridge, UpstreamError, type ChatResult } from "./bridge";

export interface CreateAppOptions {
  bridge: OpencodeBridge;
}

function openAIError(message: string, type = "invalid_request_error", code?: string) {
  return { error: { message, type, param: null, code: code ?? null } } as const;
}

function usageOf(result: ChatResult) {
  return {
    prompt_tokens: result.usage.input,
    completion_tokens: result.usage.output,
    total_tokens: result.usage.total,
  };
}

/**
 * v0: la respuesta llega completa (prompt() de opencode es blocking por request);
 * el streaming增量 vía event.subscribe llega en un hito posterior. El formato
 * SSE es válido igual: role → contenido → finish → usage → [DONE].
 */
function sseResponse(params: {
  id: string;
  created: number;
  model: string;
  result: Promise<ChatResult>;
}): Response {
  const { id, created, model, result } = params;
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
      try {
        const chat = await result;
        chunk({ role: "assistant" }, null);
        chunk({ content: chat.text }, null);
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

export function createApp({ bridge }: CreateAppOptions): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true }));

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
          result: bridge.chat(request),
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
