import { describe, expect, test } from "bun:test";
import { ModelError, type ModelRequest } from "./contracts";
import { DEFAULT_GEMINI_MODEL, GeminiClient } from "./gemini";

const API_KEY = "secret-api-key";
const SCHEMA = {
  type: "object",
  properties: { command: { type: "string" } },
  required: ["command"],
  additionalProperties: false,
};

function request(overrides: Partial<ModelRequest["settings"]> = {}): ModelRequest {
  return {
    system: "Choose one action.",
    input: "You are in a room.",
    schema: SCHEMA,
    settings: {
      model: DEFAULT_GEMINI_MODEL,
      maxOutputTokens: 256,
      thinkingBudget: 64,
      temperature: 0.2,
      ...overrides,
    },
  };
}

async function captureError(promise: Promise<unknown>): Promise<ModelError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelError);
    return error as ModelError;
  }
  throw new Error("Expected ModelError");
}

function successResponse(extra: Record<string, unknown> = {}): Response {
  return Response.json({
    candidates: [{
      content: { role: "model", parts: [{ text: "{\"command\":\"north\"}" }] },
      finishReason: "STOP",
    }],
    modelVersion: "gemini-2.5-flash-001",
    ...extra,
  });
}

describe("GeminiClient request and response", () => {
  test("explicit Gemini 3 thinking level replaces the numeric budget on the wire", async () => {
    const client = new GeminiClient(API_KEY, async (_input, init) => {
      expect(JSON.parse(String(init?.body)).generationConfig.thinkingConfig).toEqual({ thinkingLevel: "low" });
      return successResponse();
    });
    await client.generate(request({ model: "gemini-3.6-flash", thinkingBudget: null, thinkingLevel: "low" }), new AbortController().signal);
  });

  test("sends the documented structured request with a header key and blocked redirects", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (input, init) => {
      calls++;
      expect(String(input)).toBe(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      );
      expect(String(input)).not.toContain(API_KEY);
      expect(String(input)).not.toContain("?");
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-goog-api-key")).toBe(API_KEY);
      expect(headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({
        systemInstruction: { parts: [{ text: "Choose one action." }] },
        contents: [{ role: "user", parts: [{ text: "You are in a room." }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: SCHEMA,
          temperature: 0.2,
          maxOutputTokens: 256,
          thinkingConfig: { thinkingBudget: 64 },
        },
      });
      return successResponse();
    };

    const reply = await new GeminiClient(API_KEY, fetcher).generate(
      request(),
      new AbortController().signal,
    );
    expect(calls).toBe(1);
    expect(reply.text).toBe("{\"command\":\"north\"}");
    expect(reply.modelVersion).toBe("gemini-2.5-flash-001");
    expect(reply.finishReason).toBe("STOP");
  });

  test("maps each usage field and trusts the provider total without adding it again", async () => {
    const client = new GeminiClient(API_KEY, async () => successResponse({
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 5,
        cachedContentTokenCount: 4,
        totalTokenCount: 18,
      },
    }));
    const reply = await client.generate(request(), new AbortController().signal);
    expect(reply.usage).toEqual({
      promptTokens: 10,
      outputTokens: 3,
      thinkingTokens: 5,
      cachedTokens: 4,
      totalTokens: 18,
    });
  });

  test("keeps absent and malformed usage fields unknown", async () => {
    const reply = await new GeminiClient(API_KEY, async () => successResponse({
      usageMetadata: { promptTokenCount: -1, totalTokenCount: "12" },
    })).generate(request(), new AbortController().signal);
    expect(reply.usage).toEqual({
      promptTokens: null,
      outputTokens: null,
      thinkingTokens: null,
      cachedTokens: null,
      totalTokens: null,
    });
  });

  test("rejects unsafe model paths before fetching", async () => {
    let fetched = false;
    const client = new GeminiClient(API_KEY, async () => {
      fetched = true;
      return successResponse();
    });
    const error = await captureError(client.generate(
      request({ model: "gemini-2.5-flash?key=stolen" }),
      new AbortController().signal,
    ));
    expect(error.code).toBe("invalid_model");
    expect(error.retryable).toBe(false);
    expect(fetched).toBe(false);
  });
});

describe("GeminiClient provider failures", () => {
  test("preserves usage and provider metadata when the prompt is blocked", async () => {
    const body = {
      promptFeedback: { blockReason: "SAFETY" },
      usageMetadata: { promptTokenCount: 8, totalTokenCount: 8 },
      modelVersion: "gemini-2.5-flash-001",
    };
    const error = await captureError(new GeminiClient(
      API_KEY,
      async () => Response.json(body),
    ).generate(request(), new AbortController().signal));
    expect(error.code).toBe("safety_block");
    expect(error.retryable).toBe(false);
    expect(error.usage.promptTokens).toBe(8);
    expect(error.usage.totalTokens).toBe(8);
    expect(error.response).toEqual(body);
  });

  test("preserves usage and finish reason when output reaches MAX_TOKENS", async () => {
    const body = {
      candidates: [{
        content: { parts: [{ text: "{\"command\":" }] },
        finishReason: "MAX_TOKENS",
      }],
      usageMetadata: { candidatesTokenCount: 20, thoughtsTokenCount: 4, totalTokenCount: 30 },
      modelVersion: "gemini-2.5-flash-001",
    };
    const error = await captureError(new GeminiClient(
      API_KEY,
      async () => Response.json(body),
    ).generate(request(), new AbortController().signal));
    expect(error.code).toBe("max_tokens");
    expect(error.usage.outputTokens).toBe(20);
    expect(error.usage.thinkingTokens).toBe(4);
    expect(error.response).toEqual(body);
  });

  test("treats a candidate safety finish as a non-retryable block", async () => {
    const body = {
      candidates: [{ finishReason: "SAFETY", safetyRatings: [{ blocked: true }] }],
      usageMetadata: { promptTokenCount: 4, totalTokenCount: 4 },
      modelVersion: "gemini-2.5-flash-001",
    };
    const error = await captureError(new GeminiClient(
      API_KEY,
      async () => Response.json(body),
    ).generate(request(), new AbortController().signal));
    expect(error.code).toBe("safety_block");
    expect(error.retryable).toBe(false);
    expect(error.usage.totalTokens).toBe(4);
    expect(error.response).toEqual(body);
  });

  test("rejects missing candidates and malformed provider or generated JSON", async () => {
    const missing = await captureError(new GeminiClient(
      API_KEY,
      async () => Response.json({ usageMetadata: { totalTokenCount: 2 } }),
    ).generate(request(), new AbortController().signal));
    expect(missing.code).toBe("invalid_response");
    expect(missing.usage.totalTokens).toBe(2);

    const malformedProvider = await captureError(new GeminiClient(
      API_KEY,
      async () => new Response(`not-json-${API_KEY}`),
    ).generate(request(), new AbortController().signal));
    expect(malformedProvider.code).toBe("invalid_response");
    expect(String(malformedProvider.response)).not.toContain(API_KEY);

    const malformedGenerated = await captureError(new GeminiClient(
      API_KEY,
      async () => successResponse({
        candidates: [{ content: { parts: [{ text: "not json" }] }, finishReason: "STOP" }],
        usageMetadata: { totalTokenCount: 6 },
      }),
    ).generate(request(), new AbortController().signal));
    expect(malformedGenerated.code).toBe("invalid_response");
    expect(malformedGenerated.usage.totalTokens).toBe(6);
  });

  test("only marks explicit 429 and 5xx HTTP responses retryable and never retries", async () => {
    for (const [status, retryable] of [[429, true], [500, true], [503, true], [400, false]] as const) {
      let calls = 0;
      const client = new GeminiClient(API_KEY, async () => {
        calls++;
        return Response.json(
          { error: { message: "provider rejected request" }, usageMetadata: { totalTokenCount: 1 } },
          { status, headers: { "Retry-After": "1.5" } },
        );
      });
      const error = await captureError(client.generate(request(), new AbortController().signal));
      expect(error.code).toBe(`http_${status}`);
      expect(error.retryable).toBe(retryable);
      expect(error.retryAfterMs).toBe(1500);
      expect(error.usage.totalTokens).toBe(1);
      expect(calls).toBe(1);
      expect((error as ModelError & { headers?: unknown }).headers).toBeUndefined();
    }
  });

  test("redacts the API key from successful and failed provider data and errors", async () => {
    const success = await new GeminiClient(API_KEY, async () => successResponse({
      candidates: [{
        content: { parts: [{ text: `{\"command\":\"${API_KEY}\"}` }] },
        finishReason: "STOP",
      }],
      echoed: { headers: { "x-goog-api-key": API_KEY } },
    })).generate(request(), new AbortController().signal);
    expect(success.text).not.toContain(API_KEY);
    expect(JSON.stringify(success.response)).not.toContain(API_KEY);

    const failed = await captureError(new GeminiClient(API_KEY, async () => Response.json({
      error: { message: `bad credential ${API_KEY}` },
      echoed: { headers: { "x-goog-api-key": API_KEY } },
    }, {
      status: 400,
      headers: { "x-secret-response-header": API_KEY },
    })).generate(request(), new AbortController().signal));
    expect(failed.message).not.toContain(API_KEY);
    expect(JSON.stringify(failed.response)).not.toContain(API_KEY);
    expect((failed as ModelError & { headers?: unknown }).headers).toBeUndefined();

    const network = await captureError(new GeminiClient(API_KEY, async () => {
      throw new Error(`fetch leaked ${API_KEY}`);
    }).generate(request(), new AbortController().signal));
    expect(network.code).toBe("network_error");
    expect(network.message).toBe("Gemini request failed");
    expect(network.message).not.toContain(API_KEY);
    expect(network.response).toBeNull();
  });
});

describe("GeminiClient response bounds and cancellation", () => {
  test("rejects a response larger than 1 MiB and cancels its stream", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1024 * 1024 + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const error = await captureError(new GeminiClient(
      API_KEY,
      async () => new Response(stream),
    ).generate(request(), new AbortController().signal));
    expect(error.code).toBe("response_too_large");
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  test("cancels a pending body read when the supplied signal aborts", async () => {
    let beganReading!: () => void;
    const reading = new Promise<void>(resolve => { beganReading = resolve; });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        beganReading();
        return new Promise(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const result = new GeminiClient(
      API_KEY,
      async () => new Response(stream),
    ).generate(request(), controller.signal);
    await reading;
    controller.abort(new Error(API_KEY));
    const error = await captureError(result);
    expect(error.code).toBe("aborted");
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain(API_KEY);
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  test("an already-aborted request never reaches fetch", async () => {
    let fetched = false;
    const controller = new AbortController();
    controller.abort();
    const error = await captureError(new GeminiClient(API_KEY, async () => {
      fetched = true;
      return successResponse();
    }).generate(request(), controller.signal));
    expect(error.code).toBe("aborted");
    expect(error.retryable).toBe(false);
    expect(fetched).toBe(false);
  });
});
