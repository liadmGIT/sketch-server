const express = require("express");
const { OpenAI } = require("openai");

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS — allow only the Vercel frontend
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://coaster-web-eta.vercel.app");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

const SKETCH_PROMPT = `Convert the provided image into a clean 2-color black-and-white circular stencil design for a 3D printed coaster (90-100mm diameter).

VISUAL TRANSFORMATION GOAL:
Redraw all visual elements as a simplified flat graphic — like a vinyl decal, linocut print, or laser-cut stencil. This is an artistic style conversion, not a photo filter.

OUTPUT FORMAT:
- Perfect circle with thick solid black outer border
- Plain white background inside the circle
- Main subject centered inside, simplified into bold black shapes with white negative space
- No background — remove everything behind the main subject

COLOR RULES — STRICT:
- Pure black and pure white ONLY
- No gray, no gradients, no shadows, no textures
- No photographic lighting effects
- No halftone, no threshold filter, no messy noise

SHAPE RULES:
- Use large, bold, connected black shapes
- Simplify all details into clean silhouettes
- White areas = gaps/highlights within black shapes
- Avoid small isolated black islands
- Avoid thin fragile lines (must survive 3D printing)
- Avoid tiny details — everything must be printable at 90mm

STYLE REFERENCE:
The result should look like a professional custom graphic icon — clean, bold, recognizable — not like a damaged photocopy or a simple B&W photo conversion.`;

app.post("/sketch", async (req, res) => {
  console.log("Sketch request received, image size:", req.body?.imageBase64?.length ?? 0);
  const { imageBase64, mimeType } = req.body;

  if (!imageBase64) return res.status(400).json({ error: "No image provided" });
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY missing!");
    return res.status(500).json({ error: "API key not configured" });
  }
  console.log("Calling OpenAI Responses API...");

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.responses.create({
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: `data:${mimeType || "image/jpeg"};base64,${imageBase64}`,
            },
            {
              type: "input_text",
              text: SKETCH_PROMPT,
            },
          ],
        },
      ],
      tools: [{ type: "image_generation", quality: "high", size: "1024x1024" }],
    });

    const imageOutput = response.output.find((item) => item.type === "image_generation_call");
    const sketchBase64 = imageOutput?.result;

    if (!sketchBase64) {
      console.error("Response output:", JSON.stringify(response.output));
      return res.status(422).json({ error: "No image returned from model" });
    }

    res.status(200).json({ imageBase64: sketchBase64, mimeType: "image/png" });
  } catch (err) {
    console.error("OpenAI error:", err?.message);
    res.status(500).json({ error: err?.message ?? "Unknown error" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Sketch server running on port ${PORT}`));
