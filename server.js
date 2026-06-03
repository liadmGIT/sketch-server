const express = require("express");
const { OpenAI } = require("openai");
const nodemailer = require("nodemailer");

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

// ─── helper: generate sketch via Responses API ───────────────────────────────

async function generateSketch(openai, imageBase64, mimeType, quality = "low") {
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
    tools: [{ type: "image_generation", quality, size: "1024x1024" }],
  });

  const imageOutput = response.output.find((item) => item.type === "image_generation_call");
  return imageOutput?.result ?? null;
}

// ─── helper: send email ───────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendOrderEmail({ name, whatsapp, description, quantity, notes, sketch_status, photoBase64, photoMimeType, sketchBase64 }) {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASS,
    },
  });

  const photoContentType = photoMimeType || "image/jpeg";
  const photoExt = photoContentType.split("/")[1]?.replace("jpeg", "jpg") || "jpg";

  const attachments = [];
  if (photoBase64) {
    attachments.push({ filename: `photo.${photoExt}`, content: photoBase64, encoding: "base64", contentType: photoContentType });
  }
  if (sketchBase64) {
    attachments.push({ filename: "sketch.png", content: sketchBase64, encoding: "base64", contentType: "image/png" });
  }

  await transporter.sendMail({
    from: `"תחתיות אישיות" <${process.env.GMAIL_USER}>`,
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
    const sketchBase64 = await generateSketch(openai, imageBase64, mimeType, "low");

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
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASS) return res.status(500).json({ error: "Email not configured" });

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
        const highQuality = await generateSketch(openai, photoBase64, photoMimeType, "high");
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
