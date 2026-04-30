'use client';

import { useState, useRef, useEffect } from 'react';
import { extractImagesFromPdf } from '@/lib/pdf-utils';
import { determinePersonas, generateSlideScript, generateSpeech, PersonasResult, ScriptSegment } from '@/lib/ai-service';
import { pcmBase64ToWavUrl, mergePcmBase64ToWavUrl } from '@/lib/audio-utils';
import { UploadCloud, Play, Settings2, FileText, CheckCircle2, Loader2, BookOpen, MousePointer2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

type SlideState = 'PENDING' | 'GENERATING_SCRIPT' | 'GENERATING_AUDIO' | 'DONE' | 'ERROR';

interface SegmentTiming extends ScriptSegment {
  startTime: number;
  endTime: number;
}

interface SlideResult {
  id: number;
  imgBase64: string;
  state: SlideState;
  script?: string;
  audioUrl?: string;
  timings?: SegmentTiming[];
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
  const [enableAnnotations, setEnableAnnotations] = useState<boolean>(false);
  
  const [audioTime, setAudioTime] = useState<number>(0);

  useEffect(() => {
    setAudioTime(0);
  }, [activeSlideId]);

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
    const generatedAudioBase64s: string[][] = new Array(slides.length).fill([]);
    const audioPromises: Promise<void>[] = [];

    // Process scripts sequentially to maintain context
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      try {
        setActiveSlideId(slide.id);

        // Script generation
        setSlides(prev => prev.map(s => s.id === slide.id ? { ...s, state: 'GENERATING_SCRIPT' } : s));
        const scriptRes = await generateSlideScript(slide.imgBase64, personas, i, slides.length, previousSummaries, additionalInstructions, enableAnnotations);
        previousSummaries.push(scriptRes.summaryForNextSlide);
        setSlides(prev => prev.map(s => s.id === slide.id ? { ...s, script: scriptRes.script, state: 'GENERATING_AUDIO' } : s));

        // Audio generation (run concurrently over chunks if available)
        const audioPromise = (async () => {
           try {
              let finalAudioUrl = '';
              let timings: SegmentTiming[] = [];
              let slideAudioBase64s: string[] = [];

              if (enableAnnotations && scriptRes.segments && scriptRes.segments.length > 0) {
                 let currentMs = 0;
                 for (const seg of scriptRes.segments) {
                    const audioBase64 = await generateSpeech(seg.text, personas.speakerVoiceName);
                    slideAudioBase64s.push(audioBase64);
                    
                    const binaryLength = atob(audioBase64).length;
                    const durationMs = (binaryLength / 2 / 24000) * 1000;
                    
                    timings.push({
                       ...seg,
                       startTime: currentMs,
                       endTime: currentMs + durationMs
                    });
                    currentMs += durationMs;
                 }
                 generatedAudioBase64s[i] = slideAudioBase64s;
                 finalAudioUrl = mergePcmBase64ToWavUrl(slideAudioBase64s);
              } else {
                 const audioBase64 = await generateSpeech(scriptRes.script, personas.speakerVoiceName);
                 slideAudioBase64s = [audioBase64];
                 generatedAudioBase64s[i] = slideAudioBase64s;
                 finalAudioUrl = pcmBase64ToWavUrl(audioBase64);
              }

              setSlides(prev => prev.map(s => s.id === slide.id ? { ...s, state: 'DONE', audioUrl: finalAudioUrl, timings } : s));
           } catch (audioErr: any) {
              console.error(`Audio error on slide ${slide.id}:`, audioErr);
              setSlides(prev => prev.map(s => s.id === slide.id ? { ...s, state: 'ERROR', error: audioErr.message || 'Audio failed' } : s));
           }
        })();
        audioPromises.push(audioPromise);

      } catch (err: any) {
        console.error(`Error on slide ${slide.id}:`, err);
        setSlides(prev => prev.map(s => s.id === slide.id ? { ...s, state: 'ERROR', error: err.message || 'Failed processing' } : s));
      }
    }

    // Wait for all remaining audio generations to finish
    await Promise.all(audioPromises);

    const flatAudio = generatedAudioBase64s.flat().filter(a => a !== '');
    if (flatAudio.length > 0) {
      const mergedUrl = mergePcmBase64ToWavUrl(flatAudio);
      setFullLectureAudioUrl(mergedUrl);
    }

    setAppState('COMPLETE');
  };

  const activeSlide = slides.find(s => s.id === activeSlideId);
  const activeSegment = activeSlide?.timings?.find(t => audioTime >= t.startTime && audioTime < t.endTime);

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
              <div className="mt-4 space-y-3">
                <div>
                  <label className="text-[10px] text-slate-500 uppercase font-bold mb-2 block">Custom Instructions (Optional)</label>
                  <textarea 
                    value={additionalInstructions}
                    onChange={(e) => setAdditionalInstructions(e.target.value)}
                    placeholder="e.g. Focus on definitions, give medical analogies, or speak slowly..."
                    className="w-full bg-[#15181F] border border-[#2D3139] rounded p-2 text-xs text-slate-300 placeholder:text-slate-600 outline-none focus:border-blue-500/50 resize-y min-h-[60px]"
                  />
                </div>

                <div className="flex items-center justify-between bg-[#15181F] p-3 rounded border border-[#2D3139]">
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 flex items-center justify-center bg-purple-500/20 text-purple-400 rounded text-[10px]">✨</div>
                    <span className="text-[10px] uppercase tracking-wider font-bold text-slate-300">Visual Annotations (Beta)</span>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input 
                      type="checkbox" 
                      className="sr-only peer" 
                      checked={enableAnnotations} 
                      onChange={e => setEnableAnnotations(e.target.checked)} 
                    />
                    <div className="w-9 h-5 bg-[#2D3139] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-300 after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div>
                  </label>
                </div>
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
                      &quot;{personas.writerPersona}&quot;
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
                  {/* Image View with Spatial Annotations */}
                  <div className="flex justify-center bg-[#0A0C10] p-4 rounded border border-[#2D3139]">
                     <div className="relative inline-block h-[50vh]">
                       <img src={`data:image/jpeg;base64,${activeSlide.imgBase64}`} alt="Current Document Page" className="h-full w-auto object-contain rounded select-none shadow-md" />
                       {activeSegment && activeSegment.annotationType !== 'none' && (
                         <AnnotationBox annotation={activeSegment} />
                       )}
                     </div>
                  </div>
                  
                  {activeSlide.audioUrl && (
                    <div className="bg-[#15181F] p-4 rounded border border-[#2D3139] flex flex-col gap-2">
                       <h4 className="text-[10px] uppercase tracking-widest font-bold text-slate-500">Generated Audio</h4>
                       <audio 
                         controls 
                         src={activeSlide.audioUrl} 
                         onTimeUpdate={(e) => setAudioTime(e.currentTarget.currentTime * 1000)}
                         className="w-full h-8 outline-none" 
                       />
                    </div>
                  )}

                  {activeSlide.script && (
                    <div className="bg-[#15181F] p-4 rounded border border-[#2D3139] flex-1">
                      <h4 className="text-[10px] uppercase tracking-widest font-bold text-slate-500 mb-3 flex items-center gap-2">
                        <FileText className="w-3 h-3"/> Script output
                      </h4>
                      <div className="text-sm leading-relaxed text-slate-300 font-serif whitespace-pre-wrap">
                        {activeSlide.timings ? (
                           activeSlide.timings.map((seg, i) => (
                             <span key={i} className={`transition-colors ${audioTime >= seg.startTime && audioTime < seg.endTime ? 'text-white font-medium bg-blue-500/10' : ''}`}>
                               {seg.text}{" "}
                             </span>
                           ))
                        ) : (
                          activeSlide.script
                        )}
                      </div>
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
                    <p className="text-[11px] text-slate-300 truncate font-serif">&quot;{slide.script}&quot;</p>
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

function AnnotationBox({ annotation }: { annotation: any }) {
  const box = annotation.box_2d;
  if (!box || box.length !== 4) return null;
  const top = `${box[0] / 10}%`;
  const left = `${box[1] / 10}%`;
  const height = `${(box[2] - box[0]) / 10}%`;
  const width = `${(box[3] - box[1]) / 10}%`;

  const type = annotation.annotationType;
  if (type === 'none') {
    return null;
  }

  return (
    <div 
      className="absolute z-10 pointer-events-none"
      style={{ top, left, width, height }}
    >
      <AnimatePresence mode="popLayout">
        {type === 'highlight' && (
          <motion.div 
            initial={{ scaleX: 0, opacity: 0 }}
            animate={{ scaleX: 1, opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            transition={{ duration: 0.4, ease: "easeOut", type: "spring", bounce: 0 }}
            style={{ originX: 0 }}
            className="absolute -inset-1.5 md:-inset-2.5 z-[-1] bg-[rgba(250,210,0,0.4)] mix-blend-multiply rounded-md shadow-sm"
          />
        )}
        
        {type === 'underline' && (
          <div className="absolute -bottom-1 left-0 right-0 h-[4px] overflow-hidden">
             <motion.div
               initial={{ x: "-100%" }}
               animate={{ x: "0%" }}
               exit={{ opacity: 0, transition: { duration: 0.2 } }}
               transition={{ duration: 0.4, ease: "easeOut" }}
               className="w-full h-full bg-red-500 rounded-full shadow-[0_2px_8px_rgba(239,68,68,0.8)]"
             />
          </div>
        )}

        {type === 'circle' && (
          <svg 
            className="absolute -inset-2 md:-inset-3 w-[calc(100%+16px)] h-[calc(100%+16px)] md:w-[calc(100%+24px)] md:h-[calc(100%+24px)] overflow-visible"
            preserveAspectRatio="none"
            viewBox="0 0 100 100"
          >
            <defs>
              <filter id="glow-circle" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="1.5" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>
            <motion.rect
              x="2" y="2" width="96" height="96" rx="16"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
              transition={{ duration: 0.5, ease: "easeOut" }}
              fill="none"
              stroke="#ef4444"
              strokeWidth="4"
              strokeLinecap="round"
              filter="url(#glow-circle)"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}

        {type === 'arrow' && (
          <motion.div 
            initial={{ scale: 0, y: 30, x: 30, opacity: 0 }}
            animate={{ scale: 1, y: 0, x: 0, opacity: 1 }}
            exit={{ scale: 0, opacity: 0, transition: { duration: 0.2 } }}
            transition={{ type: "spring", stiffness: 200, damping: 15 }}
            className="absolute bottom-[-10px] right-[-10px] pointer-events-auto origin-top-left"
          >
            <div className="relative">
               {/* Arrow SVG pointing to the top-left (the element) */}
               <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="drop-shadow-[0_0_8px_rgba(239,68,68,0.8)] z-10 relative">
                 <line x1="22" y1="22" x2="2" y2="2"></line>
                 <polyline points="11 2 2 2 2 11"></polyline>
               </svg>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
