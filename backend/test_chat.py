import requests
import os
from os import getenv
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# --- Configuration ---
# 1. WHISPER PORT (8001 based on your screenshot)
# 2. IP ADDRESS (165.245.140.116 based on your screenshot)
STT_URL = "http://165.245.140.116:8001/v1/audio/transcriptions"

# 3. LLM PORT (443 based on your vLLM command)
LLM_URL = "http://165.245.140.116:443/v1/chat/completions"

API_KEY = getenv("AMD_LLM_API_KEY") 
AUDIO_FILE = "test_voice.wav" 

def test_pipeline():
    if not os.path.exists(AUDIO_FILE):
        print(f"❌ Error: {AUDIO_FILE} not found.")
        return

    # Step 1: Speech-to-Text (To Port 8001 - No API Key needed usually)
    print(f"--- Sending {AUDIO_FILE} to Whisper (STT) on Port 8001 ---")
    with open(AUDIO_FILE, "rb") as f:
        stt_response = requests.post(STT_URL, files={"file": f})
    
    if stt_response.status_code != 200:
        print(f"❌ STT Failed: {stt_response.status_code} - {stt_response.text}")
        return

    user_text = stt_response.json().get("text", "")
    print(f"🎤 User Said: \"{user_text}\"")

    # Step 2: Text-to-AI (To Port 443 - Needs API Key)
    print(f"--- Sending text to Qwen3 (LLM) on Port 443 ---")
    headers = {"Authorization": f"Bearer {API_KEY}"}
    payload = {
        "model": "Qwen3-30B-A3B",
        "messages": [{"role": "user", "content": user_text}]
    }
    
    llm_response = requests.post(LLM_URL, json=payload, headers=headers)
    
    if llm_response.status_code == 200:
        ai_reply = llm_response.json()["choices"][0]["message"]["content"]
        print(f"🤖 AI Reply: {ai_reply}")
    else:
        print(f"❌ LLM Failed: {llm_response.status_code} - {llm_response.text}")

if __name__ == "__main__":
    test_pipeline()