// Reads a TradingView screener screenshot with a vision model and returns the table text, cell by cell.
// Uses Google Gemini (free tier) when GEMINI_API_KEY is set, otherwise Claude when ANTHROPIC_API_KEY is set.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

const ScreenshotSchema = z.object({
  screener: z.enum(["divergence", "structure", "unknown"]),
  header_text: z.string(),
  tables: z.array(
    z.object({
      timeframes: z.array(z.string()),
      rows: z.array(
        z.object({
          symbol: z.string(),
          cells: z.array(z.array(z.string())),
        }),
      ),
    }),
  ),
});

export type ScreenshotData = z.infer<typeof ScreenshotSchema>;

const PROMPT = `This is a TradingView chart screenshot containing one or more screener tables. Transcribe them exactly.

There are two kinds of screener:
- "divergence": cells hold up to three lines such as "⚡ G🔥 25 Oct 15:15", "V↓ 25 Oct 09:15", "R↑ 24 Oct 22:00". Labels: G🔥 (Gold Buy, flame), G❄ (Gold Sell, snowflake), V↑, V↓, R↑, R↓.
- "structure": cells hold a label and a time such as "⚡ Int BOS↓" / "25 Oct 08:15". Labels: Int BOS↑, Int BOS↓, Sw BOS↑, Sw BOS↓, Int CHoCH↑, Int CHoCH↓, Sw CHoCH↑, Sw CHoCH↓ (compact forms iBOS↑, sCHoCH↓ etc. are also possible).

Output:
- screener: which kind this is.
- header_text: the small text at the very top of the image, e.g. "xyz created with TradingView.com, Oct 25, 2026 16:00 UTC+5:30". Empty string if absent.
- tables: every screener table, top to bottom. Ignore legend tables and the price axis.
  - timeframes: the column headers after SYMBOL, as printed (e.g. "15m", "1h", "4h", "1D").
  - rows: one per symbol, with the symbol as printed (e.g. "BTCUSDT.P") and cells aligned with timeframes. Each cell is a list of its text lines. Use an empty list for an empty cell or "-".

Rules for each line:
- Keep a leading "⚡" when the line shows the lightning badge; leave it out when it does not.
- Write the arrow direction (↑ or ↓) exactly as shown. Bullish labels are usually green or blue and bearish ones red or orange, which helps when an arrow is hard to see.
- G🔥 vs G❄: the flame is orange, the snowflake is a pale flake. Check each one.
- Some text is dimmed (old signals). Read it anyway; the dates matter.
- Copy dates and times digit by digit, in the format shown (e.g. "25 Oct 15:15").`;

type MediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export async function extractScreenshot(imageBase64: string, mediaType: MediaType): Promise<ScreenshotData> {
  if (process.env.GEMINI_API_KEY) return extractWithGemini(imageBase64, mediaType);
  if (process.env.ANTHROPIC_API_KEY) return extractWithClaude(imageBase64, mediaType);
  throw new Error("No vision API key is set. Add GEMINI_API_KEY (free at aistudio.google.com) in Vercel's environment variables.");
}

// ── Gemini ──

let gemini: GoogleGenAI | null = null;

// The configured model first; the others are tried when it is busy, retired or renamed.
const GEMINI_MODELS = [process.env.GEMINI_MODEL || "gemini-3.8-flash", "gemini-3.5-flash", "gemini-flash-latest", "gemini-3.5-flash-lite"];

const geminiSchema = (() => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(ScreenshotSchema) as Record<string, unknown>;
  return schema;
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function extractWithGemini(imageBase64: string, mediaType: MediaType): Promise<ScreenshotData> {
  gemini ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  let lastError: unknown;
  const models = [...new Set(GEMINI_MODELS)];
  for (let m = 0; m < models.length && m < 6; m++) {
    const model = models[m];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await gemini.models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ inlineData: { mimeType: mediaType, data: imageBase64 } }, { text: PROMPT }] }],
          config: { responseMimeType: "application/json", responseJsonSchema: geminiSchema, maxOutputTokens: 32000 },
        });
        const text = response.text;
        if (!text) throw new Error(`Gemini returned no text (finish reason: ${response.candidates?.[0]?.finishReason ?? "unknown"}).`);
        return ScreenshotSchema.parse(JSON.parse(text));
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`Gemini ${model} attempt ${attempt + 1} failed: ${msg.slice(0, 200)}`);
        if (/\b(503|500|UNAVAILABLE|INTERNAL|high demand|overloaded)\b/i.test(msg)) {
          if (attempt === 0) await sleep(3000); // busy: retry once, then move to the next model
          continue;
        }
        if (/not found|404|is not supported|no longer available/i.test(msg)) {
          // Retired model: Google's error names the replacement, so try that next.
          const suggested = msg.match(/use models\/([\w.-]+)/)?.[1];
          if (suggested && !models.includes(suggested)) models.splice(m + 1, 0, suggested);
          break;
        }
        if (/API key|PERMISSION_DENIED|429|RESOURCE_EXHAUSTED|quota/i.test(msg)) throw friendly(msg); // account problems: stop
        break; // anything else (bad request for this model, unreadable output): try the next model
      }
    }
  }
  throw friendly(lastError instanceof Error ? lastError.message : String(lastError));
}

function friendly(msg: string): Error {
  if (/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) return new Error("Gemini's free-tier limit was hit. Wait a minute and upload again.");
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(msg)) return new Error("Gemini rejected the API key. Check GEMINI_API_KEY in Vercel.");
  if (/503|UNAVAILABLE|high demand/i.test(msg)) return new Error("Google's Gemini servers are busy right now. Try the upload again in a few minutes.");
  return new Error(`Gemini could not read the screenshot: ${msg.slice(0, 300)}`);
}

// ── Claude ──

let client: Anthropic | null = null;

async function extractWithClaude(imageBase64: string, mediaType: MediaType): Promise<ScreenshotData> {
  client ??= new Anthropic();
  const response = await client.beta.messages.parse({
    model: process.env.EXTRACTION_MODEL || "claude-opus-5-5",
    max_tokens: 32000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: (process.env.EXTRACTION_EFFORT as "low" | "medium" | "high" | undefined) || "medium",
      format: betaZodOutputFormat(ScreenshotSchema),
    },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  });
  if (response.stop_reason === "refusal") throw new Error("The model declined to read this image.");
  if (response.stop_reason === "max_tokens") throw new Error("The model ran out of output space reading this image.");
  if (!response.parsed_output) throw new Error("The model's answer could not be parsed.");
  return response.parsed_output;
}
