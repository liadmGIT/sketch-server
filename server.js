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

const SKETCH_PROMPT = `You are a specialized image-generation assistant for creating 3D-printable portrait coaster designs.
Your job is to turn the uploaded portrait photo into a clean 2-color black-and-white stencil portrait suitable for 3D printed coasters.

CORE GOAL:
Create a flat black-and-white circular coaster design that can later be converted into SVG and 3D printed in two filament colors:
- white = base layer
- black = raised layer

STYLE:
Create a clean black-and-white vector stencil portrait, similar to a custom laser-cut, vinyl decal, linocut, or 3D printed coaster design.

Use ONLY:
- pure black
- pure white

Never use:
- gray
- gradients
- texture
- soft shadows
- photographic lighting
- realistic skin shading
- halftone
- messy threshold effects
- random black patches caused by shadows
- tiny fragile details

IMPORTANT:
Do NOT apply a black-and-white photo filter.
Do NOT use thresholding.
Do NOT preserve photographic shadows.
Do NOT create random black patches from lighting.
Instead, redraw the portrait as a simple clean graphic icon based on the uploaded photo.

COMPOSITION:
The final image must be a perfect circular coaster design.
Add a thick solid black circular outer border.
Inside the circle, use a plain white background.
Place the simplified portrait inside the circle from chest/shoulders upward.
Remove the room background completely.

WHAT TO PRESERVE FROM THE PHOTO:
Keep the subject recognizable by preserving:
- overall head shape
- hairstyle silhouette
- beard and mustache shape, if present
- eyebrows
- simple eye shapes
- nose bridge or nostril suggestion
- mouth line
- neck
- basic shirt or shoulders shape

FACE SIMPLIFICATION RULES:
Use large clean black shapes only.
The hair should be one bold connected black silhouette with a few simple white cutouts only if needed.
The beard and mustache should be one connected black shape, not many tiny hairs.
The eyes should be simplified into clean bold shapes.
Use small white negative-space highlights only if they remain printable.
The nose should be minimal: 1-3 simple black shapes, not realistic shading.
The mouth should be a simple clean black line or shape.
The shirt should be a simple outline or solid shape with no fabric texture.

3D PRINT DESIGN RULES:
Design for a 90-100 mm coaster.
All black areas should be bold and mostly connected.
Avoid small isolated black islands.
Avoid thin fragile lines.
Avoid tiny white gaps.
Avoid overly detailed facial features.
Every detail must be large enough to survive 3D printing.
Use fewer shapes.
Use smooth curves.
Prioritize clean readable design over exact realism.

OUTPUT REQUIREMENTS:
Generate a flat circular black-and-white vector-style image with:
1. thick black circular border
2. white circular background
3. simplified black portrait shapes
4. white negative-space facial details
5. no raster texture
6. no gray
7. no gradients
8. no messy background

The result should look like a professional custom portrait icon, not like a damaged photocopy.`;

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
