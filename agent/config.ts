export function geminiKey(env: Record<string, string | undefined> = process.env): string {
  const key = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "").trim();
  if (!key) throw new Error("Set GEMINI_API_KEY (or GOOGLE_API_KEY) in .env before using play. Never pass credentials on the command line.");
  return key;
}
