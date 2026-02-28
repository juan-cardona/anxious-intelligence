import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../.env") });

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://anxious:anxious123@localhost:5433/anxious_intelligence";

export const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? "";
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

export const MODEL_FAST = process.env.MODEL_FAST ?? "claude-opus-4-6";
export const MODEL_REVISION = process.env.MODEL_REVISION ?? "claude-opus-4-6";

// Thresholds
export const REVISION_THRESHOLD = parseFloat(process.env.REVISION_THRESHOLD ?? "0.7");
export const CONFIDENCE_INCREMENT = parseFloat(process.env.CONFIDENCE_INCREMENT ?? "0.1");
export const TENSION_INCREMENT = parseFloat(process.env.TENSION_INCREMENT ?? "0.15");
export const CASCADE_DEPTH_LIMIT = parseInt(process.env.CASCADE_DEPTH_LIMIT ?? "3", 10);
