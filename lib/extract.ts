// Reads a TradingView screener screenshot with Claude and returns the table text, cell by cell.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

export const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL || "claude-opus-5-5";

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

let client: Anthropic | null = null;

export async function extractScreenshot(imageBase64: string, mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"): Promise<ScreenshotData> {
  client ??= new Anthropic();
  const response = await client.beta.messages.parse({
    model: EXTRACTION_MODEL,
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
