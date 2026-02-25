import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";
import { existsSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");

// Load .env only if the file exists (local dev). On Render, env vars come from Dashboard only.
if (existsSync(envPath)) {
  config({ path: envPath });
}

const required = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "HOST"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(
    "Missing required env vars:",
    missing.join(", "),
    "\n",
    "• Local: create web/.env (see web/.env.example) and set these there.",
    "\n",
    "• Render: set them in Render Dashboard → Your Service → Environment (no .env file on Render)."
  );
  process.exit(1);
}
