interface WorkerRequest {
  sentinel: string;
  source: string;
  raw: string;
  previous: unknown;
}

type WorkerFailure = "loading" | "runtime" | "schema";

delete process.env.PWD;

const originalWrite = process.stdout.write.bind(process.stdout);
Object.defineProperty(process.stdout, "write", {
  configurable: false,
  writable: false,
  value: () => true,
});

// The write override above is belt and braces only: adapter code can still reach
// stdout through other paths. The single response is therefore framed with the
// host-supplied per-invocation sentinel, which the adapter never sees, so the
// host can skip any stray output that precedes it.
let sentinel = "";
let responded = false;
function respond(value: { ok: true; value: unknown } | { ok: false; stage: WorkerFailure }): void {
  if (responded) return;
  responded = true;
  try {
    originalWrite(sentinel + JSON.stringify(value));
  } catch {
    originalWrite(sentinel + '{"ok":false,"stage":"schema"}');
  }
}

function fail(stage: WorkerFailure): never {
  respond({ ok: false, stage });
  process.exit(0);
}

let request: WorkerRequest;
try {
  const value = JSON.parse(await Bun.stdin.text());
  // Adopt the frame before any validation so failures are framed too.
  if (value && typeof value === "object" && typeof value.sentinel === "string") sentinel = value.sentinel;
  if (!value || typeof value !== "object" || typeof value.sentinel !== "string" || !value.sentinel ||
      typeof value.source !== "string" ||
      typeof value.raw !== "string" || !(value.previous === null || typeof value.previous === "object")) {
    fail("loading");
  }
  request = {
    sentinel: value.sentinel,
    source: value.source,
    raw: value.raw,
    previous: value.previous,
  };
} catch {
  fail("loading");
}

let entryImport = true;
Bun.plugin({
  name: "deny-adapter-dependencies",
  setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (entryImport && args.importer === import.meta.path && args.path.startsWith("data:text/javascript;base64,")) {
        entryImport = false;
        return;
      }
      throw new Error("Adapter dependencies are disabled");
    });
  },
});

let loaded: Record<string, unknown>;
try {
  const url = `data:text/javascript;base64,${Buffer.from(request.source).toString("base64")}`;
  loaded = await import(url);
} catch {
  fail("loading");
}

if (typeof loaded.parse !== "function") fail("loading");

let value: unknown;
try {
  value = loaded.parse(request.raw, request.previous);
} catch {
  fail("runtime");
}

if (value && (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function") {
  fail("runtime");
}

respond({ ok: true, value });
