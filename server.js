const express = require("express");
const { OpenAI, toFile } = require("openai");
const { Resend } = require("resend");

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

const SKETCH_PROMPT = `Redesign the uploaded photo into a clean 2-color black-and-white stencil portrait for a 3D printed circular coaster.

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
Instead, redraw the subjects as a simple clean graphic icon based on the uploaded photo.

COMPOSITION:
The final image must be a perfect circular coaster design.
Add a thick solid black circular outer border.
Inside the circle, use a plain white background.
Place the simplified subjects inside the circle from chest/shoulders upward.
Include arms and hands if they are visible in the photo — do not cut them off.
BACKGROUND RULES: Remove busy, cluttered backgrounds completely. If the background has meaningful elements (flowers, nature), keep only 3–6 simplified decorative shapes scattered sparsely — not a dense filled pattern. The background must have plenty of white space. Never fill the entire circle with background elements. The subject must dominate — background is secondary accent only.

WHAT TO PRESERVE FROM THE PHOTO:
Keep each subject recognizable by preserving:
- overall head shape
- hairstyle silhouette AND flowing hair strand details
- beard and mustache shape, if present
- eyebrows
- simple eye shapes
- nose bridge or nostril suggestion
- mouth line
- neck
- basic shirt or shoulders shape
- hands and arms if visible

FACE SIMPLIFICATION RULES:
Use large clean black shapes as the base.
The hair should be a bold black silhouette with visible flowing strand lines drawn inside it — show hair direction and volume with clean curved lines, not just a flat black mass.
The beard and mustache should be one connected black shape with a few simple line details to suggest texture.
The eyes should be simplified into clean bold shapes.
Use small white negative-space highlights only if they remain printable.
The nose should be minimal: 1–3 simple black shapes, not realistic shading.
The mouth should be a simple clean black line or shape.
The shirt should be a simple outline or solid shape with no fabric texture.
For animals: show fur texture using a LIMITED number of bold curved lines (10–20 strokes total, not hundreds of fine hairs) — suggest fur direction and volume without filling the face with tiny details. Every fur stroke must be thick enough to survive 3D printing at 90mm. Preserve recognizable facial features (eyes, nose, mouth, ear shapes).

3D PRINT DESIGN RULES:
Design for a 90–100 mm coaster.
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
Create a flat circular black-and-white vector-style image with:
1. thick black circular border
2. white circular background
3. simplified black portrait shapes
4. white negative-space facial details
5. no raster texture
6. no gray
7. no gradients
8. no messy background

The result should look like a professional custom portrait icon, not like a damaged photocopy.`;

// ─── helper: fast preview via Responses API (gpt-image-1, quality low) ──────

async function generatePreviewSketch(openai, imageBase64, mimeType) {
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
    tools: [{ type: "image_generation", quality: "low", size: "1024x1024" }],
  });

  const imageOutput = response.output.find((item) => item.type === "image_generation_call");
  return imageOutput?.result ?? null;
}

// ─── helper: high quality via gpt-image-2 img2img ────────────────────────────

async function generateHighQualitySketch(openai, imageBase64, mimeType) {
  const imageBuffer = Buffer.from(imageBase64, "base64");
  const imageFile = await toFile(imageBuffer, "photo.jpg", {
    type: mimeType || "image/jpeg",
  });

  const result = await openai.images.edit({
    model: "gpt-image-2",
    image: imageFile,
    prompt: SKETCH_PROMPT,
    n: 1,
    size: "1024x1024",
    quality: "high",
  });

  return result.data?.[0]?.b64_json ?? null;
}

// ─── helper: send email ───────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendOrderEmail({ name, whatsapp, description, quantity, notes, sketch_status, photoBase64, photoMimeType, sketchBase64 }) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  const photoContentType = photoMimeType || "image/jpeg";
  const photoExt = photoContentType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";

  const attachments = [];
  if (photoBase64) {
    attachments.push({ filename: `photo.${photoExt}`, content: photoBase64 });
  }
  if (sketchBase64) {
    attachments.push({ filename: "sketch.png", content: sketchBase64 });
  }

  await resend.emails.send({
    from: "תחתיות אישיות <onboarding@resend.dev>",
    to: process.env.GMAIL_USER,
    subject: `🎨 הזמנה חדשה — ${esc(name)} | ${esc(quantity)}`,
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 500px;">
        <h2 style="color: #1a1a1a;">הזמנה חדשה 🎉</h2>
        <table style="border-collapse: collapse; width: 100%;">
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 8px; font-weight: bold; width: 130px;">שם</td>
            <td style="padding: 8px;">${esc(name)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 8px; font-weight: bold;">וואטסאפ</td>
            <td style="padding: 8px;">${esc(whatsapp)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 8px; font-weight: bold;">מה בתמונה</td>
            <td style="padding: 8px;">${esc(description)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 8px; font-weight: bold;">כמות</td>
            <td style="padding: 8px;">${esc(quantity)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 8px; font-weight: bold;">הערות</td>
            <td style="padding: 8px;">${esc(notes)}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold;">סטטוס סקיצה</td>
            <td style="padding: 8px;">${esc(sketch_status)}</td>
          </tr>
        </table>
        <p style="margin-top: 16px; color: #666; font-size: 0.9em;">
          ${photoBase64 ? "📎 תמונה מקורית מצורפת." : "⚠️ לא הועלתה תמונה."}<br/>
          ${sketchBase64 ? "🎨 סקיצה באיכות גבוהה מצורפת." : "ℹ️ סקיצה לא נוצרה — יש לייצר ידנית."}
        </p>
      </div>
    `,
    attachments,
  });
}

// ─── /sketch — תצוגה מקדימה מהירה (quality: low) ─────────────────────────────

app.post("/sketch", async (req, res) => {
  console.log("Preview request, image size:", req.body?.imageBase64?.length ?? 0);
  const { imageBase64, mimeType } = req.body;

  if (!imageBase64) return res.status(400).json({ error: "No image provided" });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "API key not configured" });

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const sketchBase64 = await generatePreviewSketch(openai, imageBase64, mimeType);

    if (!sketchBase64) return res.status(422).json({ error: "No image returned from model" });

    res.status(200).json({ imageBase64: sketchBase64, mimeType: "image/png" });
  } catch (err) {
    console.error("Sketch error:", err?.message);
    res.status(500).json({ error: err?.message ?? "Unknown error" });
  }
});

// ─── /order — קבלת הזמנה + סקיצה איכותית + מייל ברקע ───────────────────────

app.post("/order", async (req, res) => {
  const { name, whatsapp, description, quantity, notes, sketch_status, photoBase64, photoMimeType, sketchPreviewBase64 } = req.body;

  if (!name || !whatsapp) return res.status(400).json({ error: "Missing required fields" });
  if (!process.env.GMAIL_USER || !process.env.RESEND_API_KEY) return res.status(500).json({ error: "Email not configured" });

  console.log(`Order received: ${name} | ${quantity}`);

  // מחזיר ללקוח מיידית
  res.status(200).json({ success: true });

  // ברקע: מייצר סקיצה איכותית ושולח מייל
  (async () => {
    let finalSketch = sketchPreviewBase64; // fallback לתצוגה מקדימה

    if (photoBase64 && process.env.OPENAI_API_KEY) {
      try {
        console.log(`Generating high quality sketch for: ${name}...`);
        const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const highQuality = await generateHighQualitySketch(openai, photoBase64, photoMimeType);
        if (highQuality) {
          finalSketch = highQuality;
          console.log("High quality sketch ready.");
        }
      } catch (err) {
        console.error("High quality sketch failed, using preview:", err?.message);
      }
    }

    try {
      await sendOrderEmail({ name, whatsapp, description, quantity, notes, sketch_status, photoBase64, photoMimeType, sketchBase64: finalSketch });
      console.log(`Email sent for order: ${name}`);
    } catch (err) {
      console.error("Email failed:", err?.message);
    }
  })();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Sketch server running on port ${PORT}`));
