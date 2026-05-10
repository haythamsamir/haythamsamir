// server.js — Shopify → WATI WhatsApp integration
// Trigger: Fulfillment order transitioned to "On hold" status
// Deploy on: Railway / Render / any Node host
// Node >= 18

import express from "express";
import crypto from "crypto";

const app = express();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  SHOPIFY_WEBHOOK_SECRET: process.env.SHOPIFY_WEBHOOK_SECRET,
  WATI_API_ENDPOINT:      process.env.WATI_API_ENDPOINT,
  WATI_API_TOKEN:         process.env.WATI_API_TOKEN,
  WATI_TEMPLATE_NAME:     process.env.WATI_TEMPLATE_NAME,
  PORT:                   process.env.PORT || 3000,
};

// Governorates to filter (mapped from Shopify Province field)
const ALLOWED_PROVINCES = [
  "cairo",
  "giza",
  "6th of october",
];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function verifyShopifyHmac(req) {
  const hmacHeader = req.headers["x-shopify-hmac-sha256"];
  if (!hmacHeader) return false;
  const digest = crypto
    .createHmac("sha256", CONFIG.SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

function isAllowedProvince(destination) {
  if (!destination) return false;
  const province = (destination.province || "").trim().toLowerCase();
  return ALLOWED_PROVINCES.some((allowed) => province.includes(allowed));
}

function formatEgyptianPhone(raw) {
  let phone = (raw || "").replace(/[\s\-\+]/g, "");
  if (phone.startsWith("20")) phone = phone.slice(2);
  if (phone.startsWith("0")) phone = phone.slice(1);
  return `20${phone}`;
}

async function sendWatiTemplate(phone, templateParams) {
  const url = `${CONFIG.WATI_API_ENDPOINT}/api/v1/sendTemplateMessage?whatsappNumber=${phone}`;

  const body = {
    template_name:  CONFIG.WATI_TEMPLATE_NAME,
    broadcast_name: `shopify_on_hold_${Date.now()}`,
    parameters:     templateParams,
  };

  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${CONFIG.WATI_API_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`WATI error ${res.status}: ${errText}`);
  }
  return res.json();
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ─── WEBHOOK ENDPOINT ─────────────────────────────────────────────────────────
//
// Register this webhook in Shopify:
//   Admin → Settings → Notifications → Webhooks → Create webhook
//   Event:  Fulfillment order transitioned to the "On hold" status
//   Format: JSON
//   URL:    https://haythamsamir-production.up.railway.app/webhook/fulfillment

app.post("/webhook/fulfillment", async (req, res) => {
  // 1. Validate HMAC
  if (!verifyShopifyHmac(req)) {
    console.warn("Invalid HMAC — request rejected");
    return res.status(401).send("Unauthorized");
  }

  // Acknowledge immediately so Shopify doesn't retry
  res.status(200).send("ok");
console.log("BODY:", JSON.stringify(req.body, null, 2));

  const fulfillmentOrder = req.body;

  try {
    // 2. Get destination (shipping address)
    const destination = fulfillmentOrder.destination || null;

    // 3. Check Governorate (Province field)
    if (!isAllowedProvince(destination)) {
      console.log(`Skipping — province "${destination?.province}" not in allowed list`);
      return;
    }

    // 4. Get customer phone
    const rawPhone = destination?.phone || null;

    if (!rawPhone) {
      console.warn(`Order ${fulfillmentOrder.order_id} — no phone number found, skipping`);
      return;
    }

    const phone = formatEgyptianPhone(rawPhone);

    // 5. Build WATI template parameters
    //    Template variable: {{order_number}}
    const templateParams = [
      {
        name:  "order_number",
        value: String(fulfillmentOrder.order_id),
      },
    ];

    // 6. Send WhatsApp template
    const watiResponse = await sendWatiTemplate(phone, templateParams);
    console.log(`✓ WhatsApp sent to ${phone} for order ${fulfillmentOrder.order_id}`, watiResponse);

  } catch (err) {
    console.error("Error processing fulfillment webhook:", err.message);
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`Webhook server running on port ${CONFIG.PORT}`);
});
