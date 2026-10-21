// An agent that builds its client the default way, `new GoogleGenAI({})`: its key comes from
// GEMINI_API_KEY or GOOGLE_API_KEY, its base URL from the environment too.
import { GoogleGenAI } from '@google/genai';
import { answer } from './answer.mjs';

await answer(async (prompt) => (await new GoogleGenAI({}).models.generateContent({ model: 'gemini-2.5-flash', contents: prompt })).text);
