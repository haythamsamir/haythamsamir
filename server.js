// server.js — Shopify → WATI WhatsApp integration
// Deploy on: Railway / Render / Vercel (as serverless) / any Node host
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

function isAllowedProvince(shippingAddress) {
  if (!shippingAddress) return false;
  const province = (shippingAddress.province || "").trim().toLowerCase();
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
    broadcast_name: `shopify_in_progress_${Date.now()}`,
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
// Register this URL in Shopify:
//   Admin → Settings → Notifications → Webhooks → Create webhook
//   Event:  Fulfillment update  (fulfillments/update)
//   Format: JSON
//   URL:    https://your-server.com/webhook/fulfillment

app.post("/webhook/fulfillment", async (req, res) => {
  // 1. Validate HMAC
  if (!verifyShopifyHmac(req)) {
    console.warn("Invalid HMAC — request rejected");
    return res.status(401).send("Unauthorized");
  }

  // Acknowledge immediately so Shopify doesn't retry
  res.status(200).send("ok");

  const fulfillment = req.body;

  try {
    // 2. Check fulfillment status — "open" = in progress
    const status = (fulfillment.status || "").toLowerCase();
    if (status !== "open") {
      console.log(`Skipping — status is "${status}", not "open" (in progress)`);
      return;
    }

    // 3. Get shipping address
    const shippingAddress =
      fulfillment.destination ||
      fulfillment.shipping_address ||
      null;

    // 4. Check Governorate (Province field)
    if (!isAllowedProvince(shippingAddress)) {
      console.log(`Skipping — province "${shippingAddress?.province}" not in allowed list`);
      return;
    }

    // 5. Get customer phone
    const rawPhone =
      shippingAddress?.phone ||
      fulfillment.destination?.phone ||
      null;

    if (!rawPhone) {
      console.warn(`Order ${fulfillment.order_id} — no phone number found, skipping`);
      return;
    }

    const phone = formatEgyptianPhone(rawPhone);

    // 6. Build WATI template parameters
    //    Template has one variable only: {{1}} = order number
    const templateParams = [
      {
        name:  "1",
        value: String(fulfillment.order_id),
      },
    ];

    // 7. Send WhatsApp template
    const watiResponse = await sendWatiTemplate(phone, templateParams);
    console.log(`✓ WhatsApp sent to ${phone} for order ${fulfillment.order_id}`, watiResponse);

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
