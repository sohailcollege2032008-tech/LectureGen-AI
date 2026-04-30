import { GoogleGenAI, Type, Modality } from "@google/genai";

// Ensure this only runs on the client.
const getAI = () => {
  const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('NEXT_PUBLIC_GEMINI_API_KEY environment variable is required');
  }
  return new GoogleGenAI({ apiKey });
};

export interface PersonasResult {
  speakerVoiceName: 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';
  writerPersona: string;
  explanationGuidelines: string;
}

/**
 * Analyzes the first, middle, and last page of a document to determine
 * the best teaching/presenting persona.
 */
export async function determinePersonas(pageImagesBase64: string[], userInstructions?: string): Promise<PersonasResult> {
  const ai = getAI();

  // Pick up to 3 pages to sample (first, middle, last)
  const samples = [];
  if (pageImagesBase64.length > 0) samples.push(pageImagesBase64[0]);
  if (pageImagesBase64.length > 2) samples.push(pageImagesBase64[Math.floor(pageImagesBase64.length / 2)]);
  if (pageImagesBase64.length > 1) samples.push(pageImagesBase64[pageImagesBase64.length - 1]);

  const imageParts = samples.map((base64) => ({
    inlineData: {
      mimeType: "image/jpeg",
      data: base64,
    },
  }));

  let prompt = `Analyze these sample pages from a presentation/document.
You need to determine the best persona and voice to teach this material effectively in a non-robotic, engaging way.
CRITICAL: The spoken language for this lecture will be Egyptian Arabic (العامية المصرية), but technical terms must remain in English.
`;

  if (userInstructions && userInstructions.trim() !== '') {
    prompt += `\nADDITIONAL USER INSTRUCTIONS (Must be strictly followed):\n${userInstructions}\n`;
  }

  prompt += `
Output a JSON object with:
- speakerVoiceName: Choose exactly one of these voices: 'Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'. (Think about what fits the subject: is it serious? friendly? authoritative?)
- writerPersona: A detailed persona description for a scriptwriter (e.g. "You are an enthusiastic Egyptian professor who loves analogies...").
- explanationGuidelines: Specific guidelines for the scriptwriter based on the visuals (e.g. "Focus deeply on the diagrams, point out the arrows, avoid just reading bullet points").
`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: {
        parts: [...imageParts, { text: prompt }]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            speakerVoiceName: {
              type: Type.STRING,
              description: "Must be one of Puck, Charon, Kore, Fenrir, Zephyr"
            },
            writerPersona: {
              type: Type.STRING
            },
            explanationGuidelines: {
              type: Type.STRING
            }
          },
          required: ["speakerVoiceName", "writerPersona", "explanationGuidelines"]
        }
      }
    });

    const jsonStr = response.text?.trim() || '{}';
    return JSON.parse(jsonStr) as PersonasResult;
  } catch (error) {
    console.error("Error determining personas:", error);
    throw new Error('Failed to analyze document personas');
  }
}

export interface SlideScriptResult {
  script: string;
  summaryForNextSlide: string;
}

/**
 * Generates an audio script for a specific page.
 */
export async function generateSlideScript(
  imageBase64: string,
  personasResult: PersonasResult,
  slideIndex: number,
  totalSlides: number,
  previousSummaries: string[],
  userInstructions?: string
): Promise<SlideScriptResult> {
  const ai = getAI();

  let systemInstruction = `${personasResult.writerPersona}
  
CRITICAL INSTRUCTIONS:
- ${personasResult.explanationGuidelines}
- You are explaining slide ${slideIndex + 1} out of ${totalSlides}.
`;

  if (userInstructions && userInstructions.trim() !== '') {
    systemInstruction += `- THE USER HAS PROVIDED THESE ADDITIONAL INSTRUCTIONS for how you should teach/explain: "${userInstructions}". You must follow them strictly.\n`;
  }

  if (previousSummaries && previousSummaries.length > 0) {
    systemInstruction += `- As context, here are the summaries of what you just explained in the PREVIOUS slides:\n`;
    previousSummaries.forEach((summary, idx) => {
      systemInstruction += `  - Slide ${idx + 1}: ${summary}\n`;
    });
    systemInstruction += `Make sure to seamlessly transition and connect the ideas from the previous slides to this one.\n`;
  } else {
    systemInstruction += `- This is the FIRST slide. Start the lecture with a welcoming introduction before explaining the slide.\n`;
  }

  systemInstruction += `
- The output script MUST be in Egyptian Arabic (العامية المصرية), but keep technical and scientific terms in English.
- Do NOT just read the text literally. Use a conversational, teaching tone.
- Act like you are presenting this slide visually to your students. Feel free to say things like "زي ما إحنا شايفين في الصورة دي..." or "ركزوا معايا في الجزء ده...".
- The script should be engaging, natural, and feel like a real human explaining the concept.
- DO NOT output stage directions, ONLY output the spoken script itself.
- In addition to the script, provide a brief summary of what you just explained. This summary will be passed to you when generating the next slide's script to maintain context.
`;

  const prompt = `Here is the current slide/page. Please write the script for what you will say to explain it in Egyptian Arabic, and provide a summary for the next slide.`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-pro-preview",
      contents: {
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
          { text: prompt }
        ]
      },
      config: {
        systemInstruction,
        temperature: 0.7,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            script: { type: Type.STRING, description: "The spoken script in Egyptian Arabic." },
            summaryForNextSlide: { type: Type.STRING, description: "A brief summary to be passed as context to the next slide" }
          },
          required: ["script", "summaryForNextSlide"]
        }
      }
    });

    const jsonStr = response.text?.trim() || '{}';
    return JSON.parse(jsonStr) as SlideScriptResult;
  } catch (error) {
    console.error("Error generating script:", error);
    throw new Error('Failed to generate script for slide');
  }
}

/**
 * Generates TTS audio for a given script using the selected voice.
 */
export async function generateSpeech(text: string, voiceName: string): Promise<string> {
  const ai = getAI();

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voiceName as any },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      throw new Error("No audio returned from model");
    }
    return base64Audio;
  } catch (error) {
    console.error("Error generating speech:", error);
    throw new Error('Failed to generate speech for script');
  }
}
