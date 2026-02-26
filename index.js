import "./load-env.js";
import { URLSearchParams } from "node:url";
import express from "express";

const SHOP = process.env.SHOPIFY_SHOP || process.env.SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;
const STATIC_ACCESS_TOKEN = (process.env.SHOPIFY_ACCESS_TOKEN || "").trim();
console.log("STATIC_ACCESS_TOKEN", STATIC_ACCESS_TOKEN);
console.log("CLIENT_ID", CLIENT_ID);
console.log("CLIENT_SECRET", CLIENT_SECRET);
function normalizeShop(shop) {
  if (!shop || typeof shop !== "string") return "";
  const s = shop.trim().toLowerCase().replace(/\/$/, "");
  if (s.includes(".myshopify.com")) return s;
  return s + ".myshopify.com";
}

const SHOP_DOMAIN = normalizeShop(SHOP);

if (!SHOP_DOMAIN) {
  console.error("SHOPIFY_SHOP is missing.");
  process.exit(1);
}

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

// ── Access token ─────────────────────────────────────────────────────────────
// Strategy 1: SHOPIFY_ACCESS_TOKEN env var (custom app token — never expires)
// Strategy 2: client_credentials (Dev Dashboard org app — expires in 24h, auto-refreshed)
let ccToken = null;
let ccExpiresAt = 0;

async function getAccessToken() {
  console.log("getAccessToken function");
  // Prefer static token (from custom app in Shopify Admin)
  if (STATIC_ACCESS_TOKEN) return STATIC_ACCESS_TOKEN;

  // Fall back to client_credentials (only works for Dev Dashboard org apps)
  if (ccToken && Date.now() < ccExpiresAt - 60_000) return ccToken;

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
    const text = await response.text().catch(() => "");
    const snippet = text.length > 300 ? text.slice(0, 300) : text;
    throw new Error(
      `client_credentials failed (${response.status}). ` +
      `This grant only works for Dev Dashboard (organization) apps. ` +
      `For Partner Dashboard apps, set SHOPIFY_ACCESS_TOKEN instead. ` +
      `Response: ${snippet}`
    );
  }
  const data = await response.json();
  console.log("data", data);
  console.log("client_credentials response:", {
    access_token: data.access_token ? data.access_token.slice(0, 10) + "..." : null,
    scope: data.scope,
    expires_in: data.expires_in,
  });
  ccToken = data.access_token;
  ccExpiresAt = Date.now() + (data.expires_in ?? 86400) * 1000;
  return ccToken;
}

// ── Auth middleware ───────────────────────────────────────────────────────────
async function requireShopToken(req, res, next) {
  try {
    const accessToken = await getAccessToken();
    req.shopSession = { shop: SHOP_DOMAIN, accessToken };
    next();
  } catch (err) {
    console.error("getAccessToken failed:", err.message);
    res.status(503).json({ error: err.message, code: "token_failed" });
  }
}

// ── GraphQL helper ───────────────────────────────────────────────────────────
async function adminGraphql(shop, accessToken, query, variables = {}) {
  const url = `https://${shop}/admin/api/2026-01/graphql.json`;
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
// Don't request draftOrder.order — it requires read_orders scope. Completing still creates the order.
const DRAFT_ORDER_COMPLETE_MUTATION = `
  mutation draftOrderComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder {
        id
        status
      }
      userErrors { field message }
    }
  }
`;

const DRAFT_ORDER_DELETE_MUTATION = `
  mutation draftOrderDelete($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
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

app.get("/api/test-token", async (_req, res) => {
  try {
    const accessToken = await getAccessToken();
    const masked = accessToken.slice(0, 8) + "..." + accessToken.slice(-4);
    res.json({ ok: true, token: masked, shop: SHOP_DOMAIN });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = parseInt(process.env.PORT || "3000");
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Shop: ${SHOP_DOMAIN}`);
  console.log(`Auth: ${STATIC_ACCESS_TOKEN ? "SHOPIFY_ACCESS_TOKEN (static)" : "client_credentials (auto-refresh)"}`);

  // Test token on startup
  console.log("\n--- Testing access token on startup ---");
  try {
    const token = await getAccessToken();
    console.log(`Token OK: ${token}`);
  } catch (err) {
    console.error("Token FAILED:", err.message);
  }
});
