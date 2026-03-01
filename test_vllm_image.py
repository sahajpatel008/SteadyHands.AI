#!/usr/bin/env python3
"""
Test VLLM API for image/screenshot support.
Sends a base64-encoded image and checks if the API can process it.
"""
import base64
from pathlib import Path

from openai import OpenAI

# VLLM endpoint (same as .env)
client = OpenAI(
    base_url="http://165.245.139.104:443/v1",
    api_key="h4h-sift",
)

MODEL = "Qwen3-30B-A3B"
SCREENSHOT_PATH = Path(__file__).parent / "screenshot.png"


def main():
    if not SCREENSHOT_PATH.exists():
        print(f"[ERROR] Screenshot not found: {SCREENSHOT_PATH}")
        return 1

    # Read and base64 encode the image
    with open(SCREENSHOT_PATH, "rb") as f:
        image_data = base64.b64encode(f.read()).decode("utf-8")

    # OpenAI-compatible format: data URL with base64
    data_url = f"data:image/png;base64,{image_data}"
    print(f"[INFO] Loaded screenshot: {SCREENSHOT_PATH.name} ({len(image_data)} chars base64)")

    # Build message with image (multimodal content)
    content = [
        {
            "type": "text",
            "text": "Describe what you see in this screenshot. What is on the screen? Be brief.",
        },
        {
            "type": "image_url",
            "image_url": {"url": data_url},
        },
    ]

    print("\n[INFO] Sending request with base64 image to VLLM...")
    try:
        completion = client.chat.completions.create(
            model=MODEL,
            messages=[{"role": "user", "content": content}],
        )
        response = completion.choices[0].message.content
        print("\n[SUCCESS] API accepted the image and returned:")
        print("-" * 50)
        print(response)
        print("-" * 50)
        print("\n[RESULT] Base64 image support: YES")
        return 0

    except Exception as e:
        print(f"\n[FAILED] Error: {e}")
        err_str = str(e).lower()
        if "multimodal" in err_str or "400" in str(e):
            print("\n[RESULT] Base64 image support: NO - Model does not support vision/images")
        else:
            print("\n[RESULT] Unknown error - check API connectivity")
        return 1


if __name__ == "__main__":
    exit(main())
