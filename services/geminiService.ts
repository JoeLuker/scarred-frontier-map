
import { GoogleGenAI } from "@google/genai";
import { TerrainType, TerrainElement } from "../types";
import { AI_CONFIG } from "../constants";

const getAIClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    console.warn("API Key not found in environment variables.");
    return null;
  }
  return new GoogleGenAI({ apiKey });
};

export const generateHexDescription = async (
  terrain: TerrainType,
  element: TerrainElement
): Promise<string> => {
  const client = getAIClient();
  if (!client) return "AI description unavailable (Missing API Key).";

  const prompt = AI_CONFIG.DESCRIPTION_PROMPT(terrain, element);

  try {
    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    return response.text || "No description generated.";
  } catch (error) {
    console.error("Gemini API Error:", error);
    return "Failed to generate description from the oracle.";
  }
};

export const generateEncounter = async (
  terrain: TerrainType,
  partyLevel: number
): Promise<string> => {
  const client = getAIClient();
  if (!client) return "Encounter generation unavailable.";

  const prompt = AI_CONFIG.ENCOUNTER_PROMPT(terrain, partyLevel);

  try {
    const response = await client.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    return response.text || "No encounter details.";
  } catch (error) {
    console.error("Gemini API Error:", error);
    return "The oracle is silent.";
  }
};
