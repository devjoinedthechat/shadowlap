// Gemini on Vertex AI through @google/genai in express mode (an API key on the global endpoint).
import { GoogleGenAI } from '@google/genai';

const ai = new GoogleGenAI({ vertexai: true, apiKey: 'test-key' });
const r = await ai.models.generateContent({ model: 'gemini-2.5-flash', contents: process.env.PROMPT });
console.log(JSON.stringify({ texts: [r.text] }));
