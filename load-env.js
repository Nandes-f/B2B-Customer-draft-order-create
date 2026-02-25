import path from "path";
import { fileURLToPath } from "url";
import { config } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(__dirname, ".env") });

const required = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "HOST"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(
    "Missing required env vars:",
    missing.join(", "),
    "\nCreate web/.env with values from 'shopify app env show' (run from project root). See web/.env.example."
  );
  process.exit(1);
}
