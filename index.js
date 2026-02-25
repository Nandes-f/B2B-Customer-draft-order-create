import "./load-env.js";
import express from "express";
import { jwtVerify } from "jose";

const {
  SHOPIFY_API_KEY,
  SHOPIFY_API_SECRET,
  SCOPES = "read_draft_orders,write_draft_orders,read_customers",
} = process.env;

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

// ── Token exchange: session token → access token ─────────────────────────────
// Uses Shopify's token exchange grant: no DB, no OAuth callback, no stored tokens.
// https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/token-exchange
async function exchangeToken(sessionToken, shop) {
  const url = `https://${shop}/admin/oauth/access_token`;
  const body = {
    client_id: SHOPIFY_API_KEY,
    client_secret: SHOPIFY_API_SECRET,
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: sessionToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token",
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }
  const data = await resp.json();
  return data.access_token;
}

// ── Auth middleware for extension requests ────────────────────────────────────
async function sessionTokenAuth(req, res, next) {
  const auth = req.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Authorization header", code: "missing_auth" });
  }
  const token = auth.slice(7).trim();

  // 1. Verify the JWT signature
  let payload;
  try {
    const result = await jwtVerify(
      token,
      new TextEncoder().encode(SHOPIFY_API_SECRET),
      { algorithms: ["HS256"] }
    );
    payload = result.payload;
  } catch (err) {
    console.error("JWT verification failed:", err.message);
    return res.status(401).json({ error: "Invalid session token: " + err.message, code: "invalid_token" });
  }

  // 2. Extract shop from dest claim
  const dest = payload.dest || payload.des || "";
  const shop = String(dest).replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
  if (!shop) {
    return res.status(401).json({ error: "No shop in token", code: "no_shop" });
  }

  // 3. Exchange session token for an access token (Shopify handles this)
  let accessToken;
  try {
    accessToken = await exchangeToken(token, shop);
  } catch (err) {
    console.error("Token exchange failed:", err.message);
    return res.status(401).json({ error: err.message, code: "exchange_failed" });
  }

  // 4. Attach to request for downstream handlers
  req.shopSession = { shop, accessToken };
  next();
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
  return resp.json();
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
app.post("/api/draft-orders/:id/complete", sessionTokenAuth, async (req, res) => {
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

app.delete("/api/draft-orders/:id", sessionTokenAuth, async (req, res) => {
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

// Health check
app.get("/", (_req, res) => res.json({ status: "ok" }));

const PORT = parseInt(process.env.PORT || "3000");
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
