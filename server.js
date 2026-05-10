// server.js — Shopify → WATI WhatsApp integration
// Trigger: Fulfillment hold added to a fulfillment order
// Deploy on: Railway / Render / any Node host
// Node >= 18

import express from "express";
import crypto from "crypto";

const app = express();

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  SHOPIFY_WEBHOOK_SECRET: process.env.SHOPIFY_WEBHOOK_SECRET,
  SHOPIFY_SHOP_DOMAIN:    process.env.SHOPIFY_SHOP_DOMAIN,
  SHOPIFY_API_TOKEN:      process.env.SHOPIFY_API_TOKEN,
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

// Extract numeric ID from Shopify GID
// e.g. "gid://shopify/FulfillmentOrder/8185543819312" → "8185543819312"
function extractNumericId(gid) {
  if (!gid) return null;
  const parts = gid.split("/");
  return parts[parts.length - 1];
}

async function fetchFulfillmentOrder(fulfillmentOrderId) {
  const url = `https://${CONFIG.SHOPIFY_SHOP_DOMAIN}/admin/api/2025-01/fulfillment_orders/${fulfillmentOrderId}.json`;
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": CONFIG.SHOPIFY_API_TOKEN,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Shopify API error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return data.fulfillment_order;
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
//   Event:  Fulfillment hold added to a fulfillment order
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

  const body = req.body;

  try {
    // 2. Get fulfillment order GID and extract numeric ID
    const gid = body?.fulfillment_order?.id;
    const fulfillmentOrderId = extractNumericId(gid);

    if (!fulfillmentOrderId) {
      console.warn("No fulfillment order ID found in webhook body");
      return;
    }

    console.log(`Processing fulfillment order: ${fulfillmentOrderId}`);

    // 3. Fetch full fulfillment order details from Shopify API
    const fulfillmentOrder = await fetchFulfillmentOrder(fulfillmentOrderId);
    const destination = fulfillmentOrder?.destination || null;

    console.log(`Destination province: ${destination?.province}`);

    // 4. Check Governorate (Province field)
    if (!isAllowedProvince(destination)) {
      console.log(`Skipping — province "${destination?.province}" not in allowed list`);
      return;
    }

    // 5. Get customer phone
    const rawPhone = destination?.phone || null;

    if (!rawPhone) {
      console.warn(`Order ${fulfillmentOrder.order_id} — no phone number found, skipping`);
      return;
    }

    const phone = formatEgyptianPhone(rawPhone);

    // 6. Build WATI template parameters
    //    Template variable: {{order_number}}
    const templateParams = [
      {
        name:  "order_number",
        value: String(fulfillmentOrder.order_id),
      },
    ];

    // 7. Send WhatsApp template
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
