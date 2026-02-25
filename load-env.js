import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");

if (existsSync(envPath)) {
  config({ path: envPath });
}

const SHOP = process.env.SHOPIFY_SHOP || process.env.SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET;

const missing = [];
if (!SHOP) missing.push("SHOPIFY_SHOP or SHOP");
if (!CLIENT_ID) missing.push("SHOPIFY_CLIENT_ID or SHOPIFY_API_KEY");
if (!CLIENT_SECRET) missing.push("SHOPIFY_CLIENT_SECRET or SHOPIFY_API_SECRET");

if (missing.length) {
  console.error("Missing required env vars:", missing.join(", "));
  console.error("Set them in Render Dashboard → Environment, or in web/.env for local dev.");
  process.exit(1);
}
