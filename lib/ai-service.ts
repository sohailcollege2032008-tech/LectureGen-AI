import { GoogleGenAI, Type, Modality } from "@google/genai";

// Ensure this only runs on the client.
const getAI = () => {
  if (typeof window === 'undefined') {
    throw new Error('getAI must be called on the client');
  }
  
  let apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
  
  try {
    const selectedId = localStorage.getItem('gemini_api_key_selected_id');
    const savedKeysStr = localStorage.getItem('gemini_api_keys');
    if (selectedId && savedKeysStr) {
      const keys = JSON.parse(savedKeysStr);
      const selectedKey = keys.find((k: any) => k.id === selectedId);
      if (selectedKey && selectedKey.key) {
        apiKey = selectedKey.key;
      }
    }
  } catch (e) {
    console.error('Failed to parse API keys from localStorage', e);
  }

  if (!apiKey) {
    throw new Error('API key is required. Please set up an API Key in the top menu.');
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

export interface ScriptSegment {
  text: string;
  annotationType: 'highlight' | 'circle' | 'arrow' | 'underline' | 'none';
  box_2d: [number, number, number, number];
}

export interface SlideScriptResult {
  script: string;
  summaryForNextSlide: string;
  segments?: ScriptSegment[];
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
  userInstructions?: string,
  enableAnnotations: boolean = false
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

  if (enableAnnotations) {
    systemInstruction += `
- VISUAL ANNOTATIONS: Break your explanation into small logical segments. For each segment, output it in the 'segments' array.
- If you are referring to a visual element on the slide, provide its bounding box in 'box_2d' as [ymin, xmin, ymax, xmax] scaled 0 to 1000. For example, [100, 200, 300, 400] means ymin 10%, xmin 20%, ymax 30%, xmax 40%.
- CRITICAL ACCURACY: The 'box_2d' coordinates MUST tightly wrap the exact element, text, or figure you are referring to. Do not draw boxes too large. Pay careful attention to the visual spacing.
- Choose 'annotationType' carefully based on what you are doing in that segment:
   * 'highlight': Use for blocks of text or important paragraphs to draw attention to the background.
   * 'underline': Use for specific key phrases, important terms, or titles to underline them.
   * 'circle': Use for diagrams, numbers, or specific disconnected elements that need a clean enclosed circle.
   * 'arrow': Use to draw a pointing arrow towards a specific visual element, logo, or part of a chart.
   * 'none': Use when just talking generally and not referring to anything visual on the slide. Set box_2d to [0,0,0,0].
`;
  }

  const prompt = `Here is the current slide/page. Please write the script for what you will say to explain it in Egyptian Arabic, and provide a summary for the next slide.`;

  let responseSchema: any = {
    type: Type.OBJECT,
    properties: {
      script: { type: Type.STRING, description: "The full combined spoken script in Egyptian Arabic." },
      summaryForNextSlide: { type: Type.STRING, description: "A brief summary to be passed as context to the next slide" }
    },
    required: ["script", "summaryForNextSlide"]
  };

  if (enableAnnotations) {
    responseSchema.properties.segments = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING, description: "The spoken script for this segment." },
          annotationType: { type: Type.STRING, description: "One of: highlight, circle, arrow, underline, none" },
          box_2d: { 
            type: Type.ARRAY, 
            items: { type: Type.NUMBER },
            description: "[ymin, xmin, ymax, xmax] 0-1000 scaled"
          }
        },
        required: ["text", "annotationType", "box_2d"]
      }
    };
  }

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
        responseSchema: responseSchema
      }
    });

    const jsonStr = response.text?.trim() || '{}';
    const initialResult = JSON.parse(jsonStr) as SlideScriptResult;

    // Refinement step for annotations
    if (enableAnnotations && initialResult.segments && initialResult.segments.length > 0) {
       const refinementPrompt = `Here is the slide image and the initial script/annotations generated:

${JSON.stringify(initialResult, null, 2)}

Please review EVERY segment that has an annotation. Your goal is to drastically improve accuracy:
1. Verify the 'annotationType' (arrow, highlight, underline, circle) is the absolute best fit.
2. CRITICAL: Adjust the 'box_2d' coordinates [ymin, xmin, ymax, xmax] so they PERFECTLY AND TIGHTLY bound the referenced text/diagram/icon. If a box is currently too loose, shrink it. If it points to the wrong area, fix it.
3. If 'none' is selected but a visual reference is clearly being made, add the correct bounding box.

Return the exact same JSON structure, but with the refined and highly accurate 'box_2d' and 'annotationType' values.`;

       const refinementResponse = await ai.models.generateContent({
         model: "gemini-3.1-pro-preview",
         contents: {
           parts: [
             { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
             { text: refinementPrompt }
           ]
         },
         config: {
           systemInstruction: "You are an expert visual QA agent. Your job is to correct spatial bounding boxes ([ymin, xmin, ymax, xmax] scaled 0-1000) so they are pixel-perfect.",
           temperature: 0.1, // Low temperature for precision
           responseMimeType: "application/json",
           responseSchema: responseSchema
         }
       });

       const refinedJsonStr = refinementResponse.text?.trim() || '{}';
       return JSON.parse(refinedJsonStr) as SlideScriptResult;
    }

    return initialResult;
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
