const express = require("express");
const { OpenAI, toFile } = require("openai");
const { Resend } = require("resend");
const rateLimit = require("express-rate-limit");
const { google } = require("googleapis");

const sketchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // שעה
  max: 20, // raised from 3 — supports multi-image orders (up to 6 slots × 3 retries)
  message: { error: "יותר מדי בקשות — נסה שוב בעוד שעה" },
  standardHeaders: true,
  legacyHeaders: false,
});

const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: "יותר מדי הזמנות — נסה שוב בעוד שעה" },
  standardHeaders: true,
  legacyHeaders: false,
});

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "30mb" })); // raised for multi-image orders (up to 6 photos + sketches)

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
BACKGROUND RULES:
- The main subject always comes first — it must dominate the composition.
- If the background is plain, neutral, or unimportant (floor, wall, sky, grass, blurred scenery) → replace with pure white. Do not invent decorative elements.
- If there are multiple subjects (people or animals that are clearly part of the scene) → include ALL of them, simplified.
- If the background contains decorative or environmental elements (flowers, plants, objects) that are clearly visible and meaningful → include up to 3–5 simplified shapes sparsely. Leave plenty of white space. Never let background elements compete with the subjects.
- NEVER invent or add anything that does not exist in the original photo.

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
For animals: show fur texture using a LIMITED number of bold curved lines (5–15 strokes total, not hundreds of fine hairs) — suggest fur direction and volume without filling the face with tiny details. Every fur stroke must be thick enough to survive 3D printing at 90mm. Preserve recognizable facial features (eyes, nose, mouth, ear shapes).

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

// ─── helper: Google Sheets ────────────────────────────────────────────────────

function parseOrder(quantityStr) {
  if (quantityStr?.includes("סט 6")) return { qty: 6, price: 80 };
  if (quantityStr?.includes("סט 4")) return { qty: 4, price: 60 };
  if (quantityStr?.includes("זוג"))  return { qty: 2, price: 35 };
  return { qty: 1, price: 20 }; // "1 תחתית — ₪20" + default
}

function addBusinessDays(date, days) {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay(); // 5=Fri, 6=Sat
    if (day !== 5 && day !== 6) added++;
  }
  return d;
}

async function writeToSheet({ name, whatsapp, quantity, notes }) {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT || !process.env.GOOGLE_SHEETS_ID) {
    console.warn("Sheet skipped: missing GOOGLE_SERVICE_ACCOUNT or GOOGLE_SHEETS_ID");
    return;
  }
  try {
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });

    const now = new Date();
    const fmt = (d) => d.toLocaleDateString("he-IL", { timeZone: "Asia/Jerusalem" });

    const { qty, price } = parseOrder(quantity);
    const cost    = qty * 3;
    const profit  = price - cost;
    const deadline = addBusinessDays(now, 2);

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "גיליון1!A:K",
      valueInputOption: "USER_ENTERED",
      resource: {
        values: [[
          fmt(now),          // A - תאריך הזמנה
          name,              // B - שם
          whatsapp,          // C - וואטסאפ
          quantity,          // D - כמות
          notes || "",       // E - הערות
          cost,              // F - עלות ייצור (₪)
          profit,            // G - רווח (₪)
          "ממתין",           // H - סטטוס (מתעדכן אוטומטית ע"י Apps Script)
          "לא",              // I - שולם?
          "לא",              // J - סופק?
          fmt(deadline),     // K - מסירה מקסימלית
        ]],
      },
    });
    console.log(`Sheet updated for: ${name}`);
  } catch (err) {
    console.error("Sheet write failed:", err?.message);
  }
}

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
  // force JPEG — client always converts via canvas; avoids gpt-image-2 rejecting HEIC/PNG
  const safeType = "image/jpeg";
  const imageFile = await toFile(imageBuffer, "photo.jpg", {
    type: safeType,
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

// Convert Israeli phone number to wa.me link
// handles: 050-1234567 / 0501234567 / +9725... / 9725...
function whatsappLink(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "972" + digits.slice(1);
  const url = `https://wa.me/${digits}`;
  return `<a href="${url}" style="color:#25D366; font-weight:600; text-decoration:none;">${esc(raw)} 💬</a>`;
}

async function sendOrderEmail({ name, whatsapp, quantity, notes, sketch_status, photoBase64, photoMimeType, sketchBase64 }) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  // always JPEG from client canvas — safe filename
  const photoExt = "jpg";

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
            <td style="padding: 8px;">${whatsappLink(whatsapp)}</td>
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

// ─── helper: send multi-image order email ────────────────────────────────────

async function sendMultiOrderEmail({ name, whatsapp, quantity, notes, coasters }) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  const attachments = [];
  coasters.forEach((c, i) => {
    if (c.photoBase64) {
      attachments.push({ filename: `coaster-${i + 1}-photo.jpg`, content: c.photoBase64 });
    }
    if (c.finalSketch) {
      attachments.push({ filename: `coaster-${i + 1}-sketch.png`, content: c.finalSketch });
    }
  });

  const rowsHtml = coasters.map((c, i) => `
    <tr style="border-bottom: 1px solid #eee;">
      <td style="padding: 10px; font-weight: bold; color: #7A5A30; width: 70px;">תחתית ${i + 1}</td>
      <td style="padding: 10px; text-align: center;">
        ${c.photoBase64
          ? `<img src="data:image/jpeg;base64,${c.photoBase64}"
               style="width:72px;height:72px;object-fit:cover;border-radius:6px;display:block;margin:auto;" />`
          : '<span style="color:#999">—</span>'}
      </td>
      <td style="padding: 10px; text-align: center;">
        ${c.finalSketch
          ? `<img src="data:image/png;base64,${c.finalSketch}"
               style="width:72px;height:72px;object-fit:cover;border-radius:6px;display:block;margin:auto;" />`
          : `<span style="color:${c.status === "error" ? "#b03a2e" : "#999"}; font-size:0.85em;">
               ${c.status === "error" ? "שגיאה — לייצר ידנית" : "לא נוצרה"}</span>`}
      </td>
    </tr>
  `).join("");

  await resend.emails.send({
    from:    "תחתיות אישיות <onboarding@resend.dev>",
    to:      process.env.GMAIL_USER,
    subject: `🎨 הזמנה — ${esc(name)} | ${esc(quantity)} | ${coasters.length} תמונות שונות`,
    html: `
      <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 540px;">
        <h2 style="color: #1a1a1a; margin-bottom: 4px;">הזמנה חדשה — ${coasters.length} תמונות שונות 🎉</h2>
        <table style="border-collapse: collapse; width: 100%; margin-bottom: 20px;">
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 8px; font-weight: bold; width: 110px;">שם</td>
            <td style="padding: 8px;">${esc(name)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 8px; font-weight: bold;">וואטסאפ</td>
            <td style="padding: 8px;">${whatsappLink(whatsapp)}</td>
          </tr>
          <tr style="border-bottom: 1px solid #eee;">
            <td style="padding: 8px; font-weight: bold;">כמות</td>
            <td style="padding: 8px;">${esc(quantity)}</td>
          </tr>
          <tr>
            <td style="padding: 8px; font-weight: bold;">הערות</td>
            <td style="padding: 8px;">${esc(notes) || "—"}</td>
          </tr>
        </table>

        <h3 style="margin-bottom: 10px; color: #1a1a1a;">תחתיות:</h3>
        <table style="border-collapse: collapse; width: 100%;">
          <thead>
            <tr style="background: #f5f0e8; font-size: 0.82em; color: #7A5A30;">
              <th style="padding: 8px; text-align: right;">#</th>
              <th style="padding: 8px;">תמונה מקורית</th>
              <th style="padding: 8px;">סקיצה</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>

        <p style="margin-top: 16px; color: #888; font-size: 0.85em;">
          📎 כל התמונות והסקיצות מצורפות כקבצים נפרדים.
        </p>
      </div>
    `,
    attachments,
  });
}

// ─── /sketch — תצוגה מקדימה מהירה (quality: low) ─────────────────────────────

app.post("/sketch", sketchLimiter, async (req, res) => {
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

app.post("/order", orderLimiter, async (req, res) => {
  const {
    name, whatsapp, quantity, notes, sketch_status,
    // single-image
    photoBase64, photoMimeType, sketchPreviewBase64,
    // multi-image
    isMultiImage, coasters,
  } = req.body;

  if (!name || !whatsapp) return res.status(400).json({ error: "Missing required fields" });
  if (!process.env.GMAIL_USER || !process.env.RESEND_API_KEY) return res.status(500).json({ error: "Email not configured" });

  console.log(`Order received: ${name} | ${quantity}${isMultiImage ? ` | ${coasters?.length} images` : ""}`);

  // מחזיר ללקוח מיידית
  res.status(200).json({ success: true });

  // ─── ברקע ─────────────────────────────────────────────────────────────────
  (async () => {

    if (isMultiImage && Array.isArray(coasters) && coasters.length > 0) {
      // ── Multi-image order ──────────────────────────────────────────────────
      const openai = process.env.OPENAI_API_KEY
        ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
        : null;

      // Generate HQ sketch for each coaster sequentially (avoids rate limits)
      const coastersWithSketches = [];
      for (let i = 0; i < coasters.length; i++) {
        const c = coasters[i];
        let finalSketch = c.sketchPreviewBase64; // fallback to low-quality preview

        if (c.photoBase64 && openai) {
          try {
            console.log(`HQ sketch ${i + 1}/${coasters.length} for ${name}...`);
            const hq = await generateHighQualitySketch(openai, c.photoBase64, c.photoMimeType || "image/jpeg");
            if (hq) { finalSketch = hq; console.log(`  ✓ coaster ${i + 1} done`); }
          } catch (err) {
            console.error(`  ✗ HQ sketch ${i + 1} failed:`, err?.message);
          }
        }

        coastersWithSketches.push({ ...c, finalSketch });
      }

      try {
        await sendMultiOrderEmail({ name, whatsapp, quantity, notes, coasters: coastersWithSketches });
        console.log(`Multi-image email sent for: ${name}`);
      } catch (err) {
        console.error("Multi-image email failed:", err?.message);
      }

      try {
        const multiNotes = `${notes || ""}${notes ? " | " : ""}${coasters.length} תמונות שונות`.trim();
        await writeToSheet({ name, whatsapp, quantity, notes: multiNotes });
      } catch (err) {
        console.error("writeToSheet unhandled:", err?.message);
      }

    } else {
      // ── Single-image order (existing logic) ───────────────────────────────
      let finalSketch = sketchPreviewBase64;

      if (photoBase64 && process.env.OPENAI_API_KEY) {
        try {
          console.log(`Generating HQ sketch for: ${name}...`);
          const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
          const highQuality = await generateHighQualitySketch(openai, photoBase64, photoMimeType);
          if (highQuality) { finalSketch = highQuality; console.log("HQ sketch ready."); }
        } catch (err) {
          console.error("HQ sketch failed, using preview:", err?.message);
        }
      }

      try {
        await sendOrderEmail({ name, whatsapp, quantity, notes, sketch_status, photoBase64, photoMimeType, sketchBase64: finalSketch });
        console.log(`Email sent for: ${name}`);
      } catch (err) {
        console.error("Email failed:", err?.message);
      }

      try {
        await writeToSheet({ name, whatsapp, quantity, notes });
      } catch (err) {
        console.error("writeToSheet unhandled:", err?.message);
      }
    }

  })();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Sketch server running on port ${PORT}`));
