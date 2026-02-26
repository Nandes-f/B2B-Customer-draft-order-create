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
const HAS_STATIC_TOKEN = !!(process.env.SHOPIFY_ACCESS_TOKEN || "").trim();
const HAS_CLIENT_CREDS =
  !!(process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY) &&
  !!(process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET);

if (!SHOP) {
  console.error("Missing required env var: SHOPIFY_SHOP (e.g. your-store.myshopify.com or your-store)");
  process.exit(1);
}

if (!HAS_STATIC_TOKEN && !HAS_CLIENT_CREDS) {
  console.error(
    "Auth config missing. Provide ONE of:\n" +
    "  1. SHOPIFY_ACCESS_TOKEN  (from a custom app in Shopify Admin)\n" +
    "  2. SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET  (Dev Dashboard org app only)"
  );
  process.exit(1);
}
