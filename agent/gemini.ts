import {
  ModelError,
  type ModelClient,
  type ModelReply,
  type ModelRequest,
  type Usage,
} from "./contracts";

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REDACTED = "[REDACTED]";

type Fetcher = typeof fetch;
type JsonRecord = Record<string, unknown>;

class ResponseTooLargeError extends Error {}
class ResponseAbortedError extends Error {}
class ResponseReadError extends Error {}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function tokenField(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function usageFrom(response: unknown): Usage {
  const root = isRecord(response) ? response : null;
  const metadata = root && isRecord(root.usageMetadata)
    ? root.usageMetadata
    : null;
  return {
    promptTokens: tokenField(metadata?.promptTokenCount),
    outputTokens: tokenField(metadata?.candidatesTokenCount),
    thinkingTokens: tokenField(metadata?.thoughtsTokenCount),
    cachedTokens: tokenField(metadata?.cachedContentTokenCount),
    // Gemini's total already includes prompt, candidate, and thinking tokens.
    totalTokens: tokenField(metadata?.totalTokenCount),
  };
}

function replaceSecret(value: string, apiKey: string): string {
  return apiKey.length === 0 ? value : value.split(apiKey).join(REDACTED);
}

function sanitize(value: unknown, apiKey: string): unknown {
  if (typeof value === "string") return replaceSecret(value, apiKey);
  if (Array.isArray(value)) return value.map(item => sanitize(item, apiKey));
  if (!isRecord(value)) return value;

  const safe: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    safe[replaceSecret(key, apiKey)] = sanitize(item, apiKey);
  }
  return safe;
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === "AbortError";
}

function abortedError(): ModelError {
  return new ModelError("aborted", "Gemini request was cancelled");
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) throw new ResponseAbortedError();

  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ResponseAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new ResponseAbortedError();
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await readWithAbort(reader, signal);
      } catch (error) {
        if (error instanceof ResponseAbortedError || signal.aborted || isAbortError(error)) {
          void reader.cancel().catch(() => {});
          throw new ResponseAbortedError();
        }
        throw new ResponseReadError();
      }
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new ResponseTooLargeError();
      }
      text += decoder.decode(result.value, { stream: true });
    }
    if (signal.aborted) throw new ResponseAbortedError();
    return text + decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read may keep the lock briefly after cancellation.
    }
  }
}

function parseRetryAfter(response: Response): number | null {
  let value: string | null;
  try {
    value = response.headers.get("retry-after");
  } catch {
    return null;
  }
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function providerMessage(response: unknown, status: number): string {
  if (isRecord(response) && isRecord(response.error)) {
    const message = stringField(response.error.message);
    if (message) return message;
  }
  return `Gemini API request failed with status ${status}`;
}

function firstCandidate(response: JsonRecord): JsonRecord | null {
  if (!Array.isArray(response.candidates) || response.candidates.length === 0) {
    return null;
  }
  return isRecord(response.candidates[0]) ? response.candidates[0] : null;
}

function candidateText(candidate: JsonRecord): string | null {
  if (!isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
    return null;
  }
  const texts = candidate.content.parts
    .filter(isRecord)
    .map(part => stringField(part.text))
    .filter((part): part is string => part !== null);
  return texts.length > 0 ? texts.join("") : null;
}

function promptBlockReason(response: JsonRecord): string | null {
  return isRecord(response.promptFeedback)
    ? stringField(response.promptFeedback.blockReason)
    : null;
}

function isSafetyFinish(reason: string): boolean {
  return reason === "SAFETY"
    || reason === "BLOCKLIST"
    || reason === "PROHIBITED_CONTENT"
    || reason === "SPII"
    || reason === "IMAGE_SAFETY"
    || reason === "IMAGE_PROHIBITED_CONTENT";
}

export class GeminiClient implements ModelClient {
  readonly #apiKey: string;
  readonly #fetcher: Fetcher;

  constructor(apiKey: string, fetcher: Fetcher = fetch) {
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new ModelError("invalid_api_key", "Gemini API key is required");
    }
    this.#apiKey = apiKey;
    this.#fetcher = fetcher;
  }

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelReply> {
    if (signal.aborted) throw abortedError();

    const model = request.settings.model;
    if (typeof model !== "string" || !MODEL_ID.test(model)) {
      throw new ModelError("invalid_model", "Gemini model name is invalid");
    }

    let body: string;
    try {
      body = JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.input }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: request.schema,
          temperature: request.settings.temperature,
          maxOutputTokens: request.settings.maxOutputTokens,
          thinkingConfig: request.settings.thinkingLevel
            ? { thinkingLevel: request.settings.thinkingLevel }
            : { thinkingBudget: request.settings.thinkingBudget },
        },
      });
    } catch {
      throw new ModelError("invalid_request", "Gemini request could not be encoded");
    }

    let httpResponse: Response;
    try {
      httpResponse = await this.#fetcher(
        `${API_ROOT}/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": this.#apiKey,
          },
          body,
          signal,
          redirect: "error",
        },
      );
    } catch (error) {
      if (signal.aborted || isAbortError(error)) throw abortedError();
      throw new ModelError("network_error", "Gemini request failed");
    }

    let raw: string;
    try {
      raw = await readBounded(httpResponse, signal);
    } catch (error) {
      if (error instanceof ResponseAbortedError || signal.aborted) throw abortedError();
      if (error instanceof ResponseTooLargeError) {
        throw new ModelError("response_too_large", "Gemini response exceeded 1 MiB");
      }
      throw new ModelError("network_error", "Gemini response could not be read");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const safeRaw = replaceSecret(raw, this.#apiKey);
      if (!httpResponse.ok) {
        const retryable = isRetryableStatus(httpResponse.status);
        throw new ModelError(
          `http_${httpResponse.status}`,
          `Gemini API request failed with status ${httpResponse.status}`,
          retryable,
          usageFrom(null),
          safeRaw || null,
          parseRetryAfter(httpResponse),
        );
      }
      throw new ModelError(
        "invalid_response",
        "Gemini returned malformed JSON",
        false,
        usageFrom(null),
        safeRaw || null,
      );
    }

    const safeResponse = sanitize(parsed, this.#apiKey);
    const usage = usageFrom(safeResponse);
    if (!httpResponse.ok) {
      const retryable = isRetryableStatus(httpResponse.status);
      throw new ModelError(
        `http_${httpResponse.status}`,
        providerMessage(safeResponse, httpResponse.status),
        retryable,
        usage,
        safeResponse,
        parseRetryAfter(httpResponse),
      );
    }
    if (!isRecord(safeResponse)) {
      throw new ModelError(
        "invalid_response",
        "Gemini returned an invalid response",
        false,
        usage,
        safeResponse,
      );
    }

    const candidate = firstCandidate(safeResponse);
    if (!candidate) {
      const blockReason = promptBlockReason(safeResponse);
      throw new ModelError(
        blockReason ? "safety_block" : "invalid_response",
        blockReason ? "Gemini blocked the prompt" : "Gemini returned no candidate",
        false,
        usage,
        safeResponse,
      );
    }

    const finishReason = stringField(candidate.finishReason);
    if (finishReason === "MAX_TOKENS") {
      throw new ModelError(
        "max_tokens",
        "Gemini reached the output token limit",
        false,
        usage,
        safeResponse,
      );
    }
    if (finishReason && isSafetyFinish(finishReason)) {
      throw new ModelError(
        "safety_block",
        "Gemini blocked the response",
        false,
        usage,
        safeResponse,
      );
    }
    if (finishReason && finishReason !== "STOP") {
      throw new ModelError(
        "generation_stopped",
        "Gemini stopped before producing a complete response",
        false,
        usage,
        safeResponse,
      );
    }

    const text = candidateText(candidate);
    if (text === null) {
      throw new ModelError(
        "invalid_response",
        "Gemini returned no text",
        false,
        usage,
        safeResponse,
      );
    }
    try {
      JSON.parse(text);
    } catch {
      throw new ModelError(
        "invalid_response",
        "Gemini returned malformed generated JSON",
        false,
        usage,
        safeResponse,
      );
    }

    return {
      text,
      usage,
      modelVersion: stringField(safeResponse.modelVersion),
      finishReason,
      response: safeResponse,
    };
  }
}
