from openai import OpenAI

client = OpenAI(
    base_url="http://165.245.139.104:443/v1",
    api_key="h4h-sift"
)

try:
    print("Testing connection to Qwen3...")
    completion = client.chat.completions.create(
        model="Qwen3-30B-A3B",
        messages=[
            {"role": "user", "content": "Hello how are you?"}
        ]
    )
    print("\n[SUCCESS] Response from Qwen3:")
    print(completion.choices[0].message.content)

except Exception as e:
    print(f"\n[FAILED] Error: {e}")
