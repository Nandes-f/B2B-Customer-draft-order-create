import "./load-env.js";
import { shopifyApp } from "@shopify/shopify-app-express";
import { SQLiteSessionStorage } from "@shopify/shopify-app-session-storage-sqlite";
import express from "express";
import { jwtVerify } from "jose";

const sessionStorage = new SQLiteSessionStorage("database.sqlite");
const shopify = shopifyApp({
  sessionStorage,
  auth: {
    path: "/api/auth",
    callbackPath: "/api/auth/callback",
  },
});

const app = express();

// CORS: allow customer account UI extensions (origin: extensions.shopifycdn.com)
// Must be first so preflight OPTIONS gets a 204 and is not redirected.
const ALLOWED_ORIGINS = [
  "https://extensions.shopifycdn.com",
  "https://admin.shopify.com",
];
app.use((req, res, next) => {
  const origin = req.get("Origin");
  if (origin && (ALLOWED_ORIGINS.includes(origin) || origin.endsWith(".shopifycdn.com"))) {
    res.set("Access-Control-Allow-Origin", origin);
  }
  res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  next();
});

app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);

app.use(express.json());

// Session-token auth for customer account extension (no merchant cookie).
// Verifies JWT from Authorization: Bearer <token>, loads shop session, sets res.locals.shopify.session.
async function sessionTokenAuth(req, res, next) {
  const auth = req.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }
  const token = auth.slice(7);
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "Server misconfiguration" });
  }
  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(secret),
      { algorithms: ["HS256"] }
    );
    const dest = payload.dest;
    if (!dest) {
      return res.status(401).json({ error: "Invalid token: missing dest" });
    }
    const shop = typeof dest === "string" ? dest.replace(/^https?:\/\//, "").split("/")[0] : "";
    if (!shop) {
      return res.status(401).json({ error: "Invalid token: invalid dest" });
    }
    const sessionId = `offline_${shop}`;
    const session = await sessionStorage.loadSession(sessionId);
    if (!session) {
      return res.status(401).json({ error: "No app session for this shop. Merchant must install the app." });
    }
    res.locals.shopify = { session };
    next();
  } catch (err) {
    console.error("Session token verification failed:", err.message);
    return res.status(401).json({ error: "Invalid or expired session token" });
  }
}

// Extension-only route: complete draft order (called from customer account with Bearer token).
// Must be registered BEFORE validateAuthenticatedSession so it uses sessionTokenAuth instead.
app.post("/api/draft-orders/:id/complete", sessionTokenAuth, async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const client = new shopify.api.clients.Graphql({ session });

    const draftOrderId = parseDraftId(req.params.id);

    const response = await client.request(DRAFT_ORDER_COMPLETE_MUTATION, {
      variables: { id: draftOrderId },
    });

    const result = response.data.draftOrderComplete;

    if (result.userErrors.length > 0) {
      return res.status(422).json({ errors: result.userErrors });
    }

    res.json({
      draftOrder: result.draftOrder,
      order: result.draftOrder?.order,
    });
  } catch (error) {
    console.error("Error completing draft order:", error);
    res.status(500).json({ error: "Failed to complete draft order" });
  }
});

app.use("/api/*", shopify.validateAuthenticatedSession());

const DRAFT_ORDERS_QUERY = `
  query DraftOrdersByCustomer($query: String!) {
    draftOrders(first: 20, query: $query, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        name
        status
        totalPriceSet {
          presentmentMoney {
            amount
            currencyCode
          }
        }
        invoiceUrl
        createdAt
        lineItems(first: 5) {
          nodes {
            title
            quantity
          }
        }
        purchasingEntity {
          ... on PurchasingCompany {
            company {
              id
              name
            }
            location {
              id
              name
            }
          }
        }
      }
    }
  }
`;

const DRAFT_ORDER_COMPLETE_MUTATION = `
  mutation DraftOrderComplete($id: ID!) {
    draftOrderComplete(id: $id) {
      draftOrder {
        id
        status
        order {
          id
          name
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const DRAFT_ORDER_DELETE_MUTATION = `
  mutation DraftOrderDelete($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedDraftOrderId
      userErrors {
        field
        message
      }
    }
  }
`;

const DRAFT_ORDER_QUERY = `
  query DraftOrder($id: ID!) {
    draftOrder(id: $id) {
      id
      status
    }
  }
`;

app.get("/api/draft-orders", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const client = new shopify.api.clients.Graphql({ session });

    const customerId = req.query.customerId;
    if (!customerId) {
      return res.status(400).json({ error: "customerId is required" });
    }

    const queryFilter = `customer_id:${customerId} status:open`;

    const response = await client.request(DRAFT_ORDERS_QUERY, {
      variables: { query: queryFilter },
    });

    res.json({ draftOrders: response.data.draftOrders.nodes });
  } catch (error) {
    console.error("Error fetching draft orders:", error);
    res.status(500).json({ error: "Failed to fetch draft orders" });
  }
});

function parseDraftId(rawId) {
  if (!rawId) return null;
  const id = typeof rawId === "string" ? decodeURIComponent(rawId) : String(rawId);
  return id.startsWith("gid://") ? id : `gid://shopify/DraftOrder/${id}`;
}

app.get("/api/draft-orders/check", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const client = new shopify.api.clients.Graphql({ session });

    const draftOrderId = parseDraftId(req.query.orderId);
    if (!draftOrderId) {
      return res.status(400).json({ error: "orderId is required" });
    }
    const response = await client.request(DRAFT_ORDER_QUERY, {
      variables: { id: draftOrderId },
    });

    const draftOrder = response.data?.draftOrder;
    const isDraft =
      draftOrder && (draftOrder.status === "OPEN" || draftOrder.status === "INVOICE_SENT");

    res.json({ isDraft: !!isDraft });
  } catch (error) {
    console.error("Error checking draft order:", error);
    res.json({ isDraft: false });
  }
});

app.delete("/api/draft-orders/:id", async (req, res) => {
  try {
    const session = res.locals.shopify.session;
    const client = new shopify.api.clients.Graphql({ session });

    const draftOrderId = parseDraftId(req.params.id);

    const response = await client.request(DRAFT_ORDER_DELETE_MUTATION, {
      variables: {
        input: { id: draftOrderId },
      },
    });

    const result = response.data.draftOrderDelete;

    if (result.userErrors.length > 0) {
      return res.status(422).json({ errors: result.userErrors });
    }

    res.json({ deleted: true, deletedDraftOrderId: result.deletedDraftOrderId });
  } catch (error) {
    console.error("Error deleting draft order:", error);
    res.status(500).json({ error: "Failed to delete draft order" });
  }
});

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT || "3000");

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
