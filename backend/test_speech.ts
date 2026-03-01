import axios from 'axios';
import * as fs from 'fs';
import * as dotenv from 'dotenv';

// Load the environment variables
dotenv.config();

// Access the key using process.env
const API_KEY = process.env.ELEVEN_LABS_API_KEY;
const VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; 

async function generateChattyJay() {
  // Defensive check to make sure the key loaded
  if (!API_KEY) {
    console.error("Error: ELEVEN_LABS_API_KEY is not defined in .env file");
    return;
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;

  try {
    const response = await axios({
      method: 'post',
      url: url,
      data: {
        text: "Yo! It's Jay here. I'm actually talking now because we waited for the stream to finish!",
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.8,
        }
      },
      headers: {
        'Accept': 'audio/mpeg',
        'xi-api-key': API_KEY, 
        'Content-Type': 'application/json',
      },
      responseType: 'stream'
    });

    // 1. Create the write stream
    const writer = fs.createWriteStream('jay_voice.mp3');

    // 2. Pipe the audio data into the file
    response.data.pipe(writer);

    // 3. Wait for the stream to completely finish before exiting
    await new Promise((resolve, reject) => {
      writer.on('finish', () => {
        console.log("✅ Success! The audio stream has finished saving to jay_voice.mp3");
        resolve(true);
      });
      writer.on('error', (err) => {
        console.error("❌ Error writing the file:", err);
        reject(err);
      });
    });
    
  } catch (error: any) {
    if (error.response && error.response.data) {
      let errorData = '';
      error.response.data.on('data', (chunk: any) => {
        errorData += chunk.toString();
      });
      error.response.data.on('end', () => {
        console.error("Actual ElevenLabs Error Message:", errorData);
      });
    } else {
      console.error("System Error:", error.message);
    }
  }
}

generateChattyJay();