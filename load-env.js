import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");

if (existsSync(envPath)) {
  config({ path: envPath });
}

const required = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(
    "Missing required env vars:",
    missing.join(", "),
    "\nSet them in Render Dashboard → Environment, or in web/.env for local dev."
  );
  process.exit(1);
}
