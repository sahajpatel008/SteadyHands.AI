from openai import OpenAI
from os import getenv
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Your Public IP and Port 443
client = OpenAI(
    base_url="http://165.245.139.104:443/v1",
    api_key=getenv("AMD_LLM_API_KEY")
)

try:
    print("Testing connection to Qwen3...")
    completion = client.chat.completions.create(
        model="Qwen3-30B-A3B",
        messages=[
            {"role": "user", "content": "The server is live. Give me a short high-five response!"}
        ]
    )
    print("\n[SUCCESS] Response from Qwen3:")
    print(completion.choices[0].message.content)

except Exception as e:
    print(f"\n[FAILED] Error: {e}")