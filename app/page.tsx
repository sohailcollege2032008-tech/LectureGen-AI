'use client';

import { useState, useRef, useEffect } from 'react';
import { extractImagesFromPdf } from '@/lib/pdf-utils';
import { determinePersonas, generateSlideScript, generateSpeech, PersonasResult } from '@/lib/ai-service';
import { pcmBase64ToWavUrl, mergePcmBase64ToWavUrl } from '@/lib/audio-utils';
import { UploadCloud, Play, Settings2, FileText, CheckCircle2, Loader2, BookOpen } from 'lucide-react';

type SlideState = 'PENDING' | 'GENERATING_SCRIPT' | 'GENERATING_AUDIO' | 'DONE' | 'ERROR';

interface SlideResult {
  id: number;
  imgBase64: string;
  state: SlideState;
  script?: string;
  audioUrl?: string;
  error?: string;
}

export default function Home() {
  const [appState, setAppState] = useState<'IDLE' | 'EXTRACTING_PDF' | 'ANALYZING_PERSONAS' | 'READY' | 'GENERATING_LECTURE' | 'COMPLETE' | 'ERROR'>('IDLE');
  const [error, setError] = useState<string | null>(null);
  
  const [personas, setPersonas] = useState<PersonasResult | null>(null);
  const [slides, setSlides] = useState<SlideResult[]>([]);
  const [activeSlideId, setActiveSlideId] = useState<number | null>(null);
  const [fullLectureAudioUrl, setFullLectureAudioUrl] = useState<string | null>(null);
  const [additionalInstructions, setAdditionalInstructions] = useState<string>('');

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setError(null);
    setAppState('EXTRACTING_PDF');
    setSlides([]);
    setPersonas(null);
    setFullLectureAudioUrl(null);

    try {
      const extractedImages = await extractImagesFromPdf(file);
      
      const initialSlides = extractedImages.map((img, i) => ({
        id: i,
        imgBase64: img,
        state: 'PENDING' as SlideState
      }));
      setSlides(initialSlides);
      if (initialSlides.length > 0) setActiveSlideId(initialSlides[0].id);

      setAppState('ANALYZING_PERSONAS');
      const personaRes = await determinePersonas(extractedImages, additionalInstructions);
      setPersonas(personaRes);
      
      setAppState('READY');
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to process document.');
      setAppState('IDLE');
    }
  };

  const startLectureGeneration = async () => {
    if (!personas || slides.length === 0) return;
    setAppState('GENERATING_LECTURE');
    setFullLectureAudioUrl(null);

    let previousSummaries: string[] = [];
    const generatedAudioBase64s: string[] = new Array(slides.length).fill('');
    const audioPromises: Promise<void>[] = [];

    // Process scripts sequentially to maintain context
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      try {
        setActiveSlideId(slide.id);

        // Script generation
        setSlides(prev => prev.map(s => s.id === slide.id ? { ...s, state: 'GENERATING_SCRIPT' } : s));
        const scriptRes = await generateSlideScript(slide.imgBase64, personas, i, slides.length, previousSummaries, additionalInstructions);
        previousSummaries.push(scriptRes.summaryForNextSlide);
        setSlides(prev => prev.map(s => s.id === slide.id ? { ...s, script: scriptRes.script, state: 'GENERATING_AUDIO' } : s));

        // Audio generation (run concurrently)
        const audioPromise = (async () => {
           try {
              const audioBase64 = await generateSpeech(scriptRes.script, personas.speakerVoiceName);
              generatedAudioBase64s[i] = audioBase64;
              const audioUrl = pcmBase64ToWavUrl(audioBase64);
              setSlides(prev => prev.map(s => s.id === slide.id ? { ...s, state: 'DONE', audioUrl } : s));
           } catch (audioErr: any) {
              console.error(`Audio error on slide ${slide.id}:`, audioErr);
              setSlides(prev => prev.map(s => s.id === slide.id ? { ...s, state: 'ERROR', error: audioErr.message || 'Audio failed' } : s));
           }
        })();
        audioPromises.push(audioPromise);

      } catch (err: any) {
        console.error(`Error on slide ${slide.id}:`, err);
        setSlides(prev => prev.map(s => s.id === slide.id ? { ...s, state: 'ERROR', error: err.message || 'Failed processing' } : s));
        // Push a placeholder empty string to keep arrays aligned in case of script error, or continue
      }
    }

    // Wait for all remaining audio generations to finish
    await Promise.all(audioPromises);

    const validAudio = generatedAudioBase64s.filter(a => a !== '');
    if (validAudio.length > 0) {
      const mergedUrl = mergePcmBase64ToWavUrl(validAudio);
      setFullLectureAudioUrl(mergedUrl);
    }

    setAppState('COMPLETE');
  };

  const activeSlide = slides.find(s => s.id === activeSlideId);

  return (
    <div className="flex flex-col h-screen bg-[#0F1115] text-[#E0E2E6] font-sans overflow-hidden">
      {/* Top Navigation */}
      <nav className="h-14 shrink-0 border-b border-[#2D3139] flex items-center justify-between px-6 bg-[#15181F]">
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center">
            <span className="font-bold text-white">G</span>
          </div>
          <h1 className="text-sm font-semibold tracking-wide uppercase">LectureGen AI Course Architect</h1>
        </div>
        <div className="flex gap-3">
          <button 
            onClick={startLectureGeneration}
            disabled={appState !== 'READY'}
            className="px-3 py-1.5 text-xs bg-blue-600 rounded hover:bg-blue-500 disabled:bg-slate-700 disabled:text-slate-400 font-medium text-white transition-colors flex items-center gap-2"
          >
            {appState === 'GENERATING_LECTURE' ? (
              <><Loader2 className="w-3 h-3 animate-spin"/> Processing...</>
            ) : appState === 'COMPLETE' ? (
              <><CheckCircle2 className="w-3 h-3"/> Complete</>
            ) : (
               <><Play className="w-3 h-3" /> Run Automation</>
            )}
          </button>
        </div>
      </nav>

      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar: Settings & Personas */}
        <aside className="w-72 shrink-0 border-r border-[#2D3139] bg-[#0A0C10] flex flex-col overflow-y-auto">
          <div className="p-4 border-b border-[#2D3139] bg-[#12151B]">
            <h2 className="text-[10px] text-blue-400 font-bold uppercase tracking-widest mb-2">Upload & Source</h2>
            {/* Upload Area */}
            <div className={`relative border border-dashed rounded p-3 text-center transition-colors ${appState === 'IDLE' ? 'border-blue-500/50 bg-blue-500/5 hover:bg-blue-500/10 cursor-pointer' : 'border-[#2D3139] bg-[#15181F]'}`}>
               <input 
                 type="file" 
                 accept="application/pdf" 
                 onChange={handleFileUpload}
                 disabled={appState !== 'IDLE' && appState !== 'READY' && appState !== 'COMPLETE' && appState !== 'ERROR'}
                 className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-auto"
               />
               <div className="text-[11px] font-medium text-slate-300 pointer-events-none">
                 {appState === 'EXTRACTING_PDF' ? (
                   <span className="flex items-center justify-center gap-2 text-blue-400"><Loader2 className="w-3 h-3 animate-spin"/> Parsing PDF...</span>
                 ) : slides.length > 0 ? (
                   <span className="text-blue-400">Loaded {slides.length} slides</span>
                 ) : (
                   <span>Click to Upload PDF</span>
                 )}
               </div>
            </div>
            {error && <p className="text-red-400 text-[10px] mt-2">{error}</p>}
            
            {(appState === 'IDLE' || appState === 'ERROR' || appState === 'READY' || appState === 'COMPLETE') && (
              <div className="mt-4">
                <label className="text-[10px] text-slate-500 uppercase font-bold mb-2 block">Custom Instructions (Optional)</label>
                <textarea 
                  value={additionalInstructions}
                  onChange={(e) => setAdditionalInstructions(e.target.value)}
                  placeholder="e.g. Focus on definitions, give medical analogies, or speak slowly..."
                  className="w-full bg-[#15181F] border border-[#2D3139] rounded p-2 text-xs text-slate-300 placeholder:text-slate-600 outline-none focus:border-blue-500/50 resize-y min-h-[60px]"
                />
              </div>
            )}
          </div>

          <div className="p-4 space-y-6">
            {appState === 'ANALYZING_PERSONAS' && (
              <div className="bg-[#15181F] rounded p-3 border border-[#2D3139] flex items-center gap-2 text-blue-400">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span className="text-[11px]">Analyzing personas...</span>
              </div>
            )}
            
            {personas && (
              <>
                <div>
                  <label className="text-[10px] text-slate-500 uppercase font-bold mb-3 flex items-center gap-2">
                    <Settings2 className="w-3 h-3" /> Audio Profile (TTS)
                  </label>
                  <div className="bg-[#15181F] p-3 rounded border border-[#2D3139]">
                    <div className="flex items-center gap-2 text-sm text-slate-200">
                       <div className="w-5 h-5 flex items-center justify-center bg-blue-500/20 text-blue-400 rounded text-[10px]">🔊</div>
                       <span className="text-xs font-semibold">{personas.speakerVoiceName}</span>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="text-[10px] text-slate-500 uppercase font-bold mb-3 block">Instructor Persona</label>
                  <div className="bg-[#15181F] p-3 rounded border border-[#2D3139]">
                    <div className="text-[11px] text-slate-400 leading-relaxed italic line-clamp-6" title={personas.writerPersona}>
                      "{personas.writerPersona}"
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </aside>

        {/* Main: Slide Details View */}
        <main className="flex-1 bg-[#0F1115] p-6 overflow-hidden flex flex-col">
          {activeSlide ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <div className="flex gap-4">
                  <div className="px-3 py-1.5 bg-blue-600/10 border border-blue-500/50 text-blue-400 text-[10px] uppercase font-bold tracking-wider rounded">Slide View</div>
                </div>
                <div className="text-xs text-slate-500 font-mono">Slide {activeSlide.id + 1} of {slides.length}</div>
              </div>

              <div className="flex-1 bg-[#1A1D24] rounded-lg border border-[#2D3139] relative flex flex-col shadow-inner overflow-hidden">
                <div className="flex-1 overflow-y-auto p-6 space-y-6 flex flex-col">
                  {/* Image View */}
                  <div className="flex justify-center bg-[#0A0C10] p-4 rounded border border-[#2D3139]">
                     <img src={`data:image/jpeg;base64,${activeSlide.imgBase64}`} alt="Current Document Page" className="max-h-[50vh] object-contain rounded" />
                  </div>
                  
                  {activeSlide.audioUrl && (
                    <div className="bg-[#15181F] p-4 rounded border border-[#2D3139] flex flex-col gap-2">
                       <h4 className="text-[10px] uppercase tracking-widest font-bold text-slate-500">Generated Audio</h4>
                       <audio controls src={activeSlide.audioUrl} className="w-full h-8 outline-none" />
                    </div>
                  )}

                  {activeSlide.script && (
                    <div className="bg-[#15181F] p-4 rounded border border-[#2D3139] flex-1">
                      <h4 className="text-[10px] uppercase tracking-widest font-bold text-slate-500 mb-3 flex items-center gap-2">
                        <FileText className="w-3 h-3"/> Script output
                      </h4>
                      <p className="text-sm leading-relaxed text-slate-300 font-serif whitespace-pre-wrap">{activeSlide.script}</p>
                    </div>
                  )}

                  {activeSlide.error && (
                    <div className="bg-red-500/10 p-3 rounded border border-red-500/30 text-red-400 text-xs flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0"></div>
                      {activeSlide.error}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                 <div className="w-16 h-16 bg-[#15181F] border border-[#2D3139] rounded flex items-center justify-center text-slate-600 mx-auto mb-4">
                    <BookOpen className="w-8 h-8"/>
                 </div>
                 <div className="text-sm text-slate-500">Upload a document to begin analysis.</div>
              </div>
            </div>
          )}
        </main>

        {/* Right Sidebar: Processing Queue */}
        <aside className="w-80 shrink-0 border-l border-[#2D3139] bg-[#0A0C10] flex flex-col">
          <div className="p-4 border-b border-[#2D3139] bg-[#12151B]">
            <h2 className="text-[10px] text-amber-400 font-bold uppercase tracking-widest mb-2">Processing Queue</h2>
            <div className="text-xs text-slate-400">Total segments: {slides.length}</div>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-3">
             {fullLectureAudioUrl && (
               <div className="bg-[#15181F] border border-green-500/50 p-3 rounded shadow-sm shadow-green-500/10 mb-4 flex flex-col gap-2">
                 <h3 className="text-[10px] uppercase tracking-widest font-bold text-green-400 flex items-center gap-2">
                   <Play className="w-3 h-3" /> Full Lecture Audio
                 </h3>
                 <audio controls src={fullLectureAudioUrl} className="w-full h-8 outline-none" />
               </div>
             )}

             {slides.map(slide => (
               <div 
                 key={slide.id}
                 onClick={() => setActiveSlideId(slide.id)}
                 className={`p-3 rounded border cursor-pointer transition-colors ${activeSlideId === slide.id ? 'bg-[#1A1D24] border-blue-500/50 relative shadow-[0_0_15px_rgba(59,130,246,0.1)]' : 'bg-[#15181F] border-[#2D3139] hover:border-slate-600'}`}
               >
                  {activeSlideId === slide.id && <div className="absolute left-0 top-0 bottom-0 w-1 bg-blue-500 rounded-l"></div>}
                  <div className="flex justify-between items-start mb-2">
                    <span className="text-[10px] font-mono text-slate-500">SEG_{String(slide.id + 1).padStart(2, '0')}</span>
                    <StateBadge state={slide.state} />
                  </div>
                  {slide.script ? (
                    <p className="text-[11px] text-slate-300 truncate font-serif">"{slide.script}"</p>
                  ) : (
                    <p className="text-[11px] text-slate-500 italic">No script yet...</p>
                  )}
                  {(slide.state === 'GENERATING_SCRIPT' || slide.state === 'GENERATING_AUDIO') && (
                     <div className="mt-2 flex gap-1">
                       <div className="h-1 w-2/3 bg-blue-500 rounded-full animate-pulse"></div>
                       <div className="h-1 w-1/3 bg-slate-700 rounded-full"></div>
                     </div>
                  )}
                  {slide.state === 'PENDING' && (
                     <div className="mt-2 h-1 w-full bg-slate-700 rounded-full"></div>
                  )}
                  {slide.state === 'DONE' && (
                     <div className="mt-2 flex gap-1">
                       <div className="h-1 flex-1 bg-green-500 rounded-full"></div>
                     </div>
                  )}
               </div>
             ))}
             {slides.length === 0 && (
               <div className="text-[11px] text-slate-600 italic px-2">Queue empty</div>
             )}
          </div>
          
          {slides.length > 0 && (
             <div className="p-4 border-t border-[#2D3139] bg-[#12151B]">
               <div className="flex justify-between text-[10px] mb-2">
                  <span className="text-slate-400">Total Completion</span>
                  <span className="text-blue-400">{Math.round((slides.filter(s => s.state === 'DONE').length / slides.length) * 100)}%</span>
               </div>
               <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 transition-all duration-500" style={{ width: `${(slides.filter(s => s.state === 'DONE').length / slides.length) * 100}%` }}></div>
               </div>
             </div>
          )}
        </aside>
      </div>

      {/* Footer Status */}
      <footer className="h-8 shrink-0 border-t border-[#2D3139] flex items-center justify-between px-6 bg-[#0A0C10] text-[9px] text-slate-500 font-mono">
        <div className="flex gap-4">
          <span>● AI Engine: Gemini 3.1 Pro & Flash TTS</span>
        </div>
        <div className="flex gap-4">
          <span>Persona Mode: {personas ? 'Active' : 'Awaiting Content'}</span>
          <span>V 1.0.0</span>
        </div>
      </footer>
    </div>
  );
}

function StateBadge({ state }: { state: SlideState }) {
  if (state === 'PENDING') {
     return <span className="text-[9px] bg-slate-700 text-slate-400 px-1.5 py-0.5 rounded uppercase">WAITING</span>;
  }
  if (state === 'GENERATING_SCRIPT') {
     return <span className="text-[9px] bg-amber-500/20 text-amber-400 px-1.5 py-0.5 rounded uppercase">SCRIPTING</span>;
  }
  if (state === 'GENERATING_AUDIO') {
     return <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded uppercase">TTS RENDERING</span>;
  }
  if (state === 'DONE') {
     return <span className="text-[9px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded uppercase">DONE</span>;
  }
  if (state === 'ERROR') {
     return <span className="text-[9px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded uppercase">ERROR</span>;
  }
  return null;
}
