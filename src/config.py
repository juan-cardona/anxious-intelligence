import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://anxious:anxious123@localhost:5433/anxious_intelligence")

ANTHROPIC_BASE_URL = os.getenv("ANTHROPIC_BASE_URL", "")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

MODEL_FAST = os.getenv("MODEL_FAST", "claude-opus-4-6")
MODEL_REVISION = os.getenv("MODEL_REVISION", "claude-opus-4-6")

# Thresholds
REVISION_THRESHOLD = float(os.getenv("REVISION_THRESHOLD", "0.7"))
CONFIDENCE_INCREMENT = float(os.getenv("CONFIDENCE_INCREMENT", "0.1"))
TENSION_INCREMENT = float(os.getenv("TENSION_INCREMENT", "0.15"))
CASCADE_DEPTH_LIMIT = int(os.getenv("CASCADE_DEPTH_LIMIT", "3"))
