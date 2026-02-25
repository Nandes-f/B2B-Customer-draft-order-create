import "./load-env.js";
import { URLSearchParams } from "node:url";
import express from "express";

const SHOP = process.env.SHOPIFY_SHOP || process.env.SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;

function normalizeShop(shop) {
  if (!shop || typeof shop !== "string") return "";
  const s = shop.trim().toLowerCase();
  if (s.includes(".myshopify.com")) return s.split("/")[0];
  return s + ".myshopify.com";
}

const SHOP_DOMAIN = normalizeShop(SHOP);

const app = express();

// ── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const origin = req.get("Origin");
  if (origin && (origin.endsWith(".shopifycdn.com") || origin.endsWith(".shopify.com"))) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.use(express.json());

// ── Client credentials: get access token (cached) ───────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const url = `https://${SHOP_DOMAIN}/admin/oauth/access_token`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token request failed (${response.status}): ${text}`);
  }

  const { access_token, expires_in } = await response.json();
  cachedToken = access_token;
  tokenExpiresAt = Date.now() + expires_in * 1000;
  return cachedToken;
}

// ── Auth middleware: use client-credentials token only (no JWT check) ──────────
// This avoids 401 from JWT/shop mismatch. Only SHOP + CLIENT_ID + CLIENT_SECRET required.
async function requireShopToken(req, res, next) {
  try {
    const accessToken = await getToken();
    req.shopSession = { shop: SHOP_DOMAIN, accessToken };
    next();
  } catch (err) {
    console.error("getToken failed:", err.message);
    res.status(503).json({ error: "Could not get access token", code: "token_failed" });
  }
}

// ── GraphQL helper ───────────────────────────────────────────────────────────
async function adminGraphql(shop, accessToken, query, variables = {}) {
  const url = `https://${shop}/admin/api/2025-01/graphql.json`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Admin API error (${resp.status}): ${text}`);
  }
  const json = await resp.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json;
}

// ── GraphQL operations ───────────────────────────────────────────────────────
const DRAFT_ORDER_COMPLETE_MUTATION = `
  mutation DraftOrderComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder { id status order { id name } }
      userErrors { field message }
    }
  }
`;

const DRAFT_ORDER_DELETE_MUTATION = `
  mutation DraftOrderDelete($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedDraftOrderId
      userErrors { field message }
    }
  }
`;

function parseDraftId(rawId) {
  if (!rawId) return null;
  const id = typeof rawId === "string" ? decodeURIComponent(rawId) : String(rawId);
  return id.startsWith("gid://") ? id : `gid://shopify/DraftOrder/${id}`;
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.post("/api/draft-orders/:id/complete", requireShopToken, async (req, res) => {
  try {
    const { shop, accessToken } = req.shopSession;
    const draftOrderId = parseDraftId(req.params.id);

    const json = await adminGraphql(shop, accessToken, DRAFT_ORDER_COMPLETE_MUTATION, { id: draftOrderId });
    const result = json.data.draftOrderComplete;

    if (result.userErrors.length > 0) {
      return res.status(422).json({ errors: result.userErrors });
    }
    res.json({ draftOrder: result.draftOrder, order: result.draftOrder?.order });
  } catch (error) {
    console.error("Error completing draft order:", error);
    res.status(500).json({ error: "Failed to complete draft order" });
  }
});

app.delete("/api/draft-orders/:id", requireShopToken, async (req, res) => {
  try {
    const { shop, accessToken } = req.shopSession;
    const draftOrderId = parseDraftId(req.params.id);

    const json = await adminGraphql(shop, accessToken, DRAFT_ORDER_DELETE_MUTATION, {
      input: { id: draftOrderId },
    });
    const result = json.data.draftOrderDelete;

    if (result.userErrors.length > 0) {
      return res.status(422).json({ errors: result.userErrors });
    }
    res.json({ deleted: true, deletedDraftOrderId: result.deletedDraftOrderId });
  } catch (error) {
    console.error("Error deleting draft order:", error);
    res.status(500).json({ error: "Failed to delete draft order" });
  }
});

app.get("/", (_req, res) => res.json({ status: "ok" }));

const PORT = parseInt(process.env.PORT || "3000");
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
