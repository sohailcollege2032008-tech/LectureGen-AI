import { ScriptSegment } from './ai-service';

export interface SegmentTiming extends ScriptSegment {
  startTime: number;
  endTime: number;
}

export async function exportToVideo(
  imageSrc: string,
  audioUrl: string,
  timing: SegmentTiming[],
  onProgress: (progress: number) => void
): Promise<{url: string, mimeType: string}> {
  return new Promise(async (resolve, reject) => {
    try {
      const canvas = document.createElement('canvas');
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = imageSrc;
      });

      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error("Could not get 2D context");

      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.src = audioUrl;

      await new Promise((res) => {
        audio.onloadedmetadata = res;
      });

      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      await audioCtx.resume();
      
      const source = audioCtx.createMediaElementSource(audio);
      const destination = audioCtx.createMediaStreamDestination();
      source.connect(destination);
      source.connect(audioCtx.destination);

      const canvasStream = canvas.captureStream(30);
      const audioStream = destination.stream;

      const tracks = [
        ...canvasStream.getVideoTracks(),
        ...audioStream.getAudioTracks()
      ];

      const mediaStream = new MediaStream(tracks);
      
      const mimeTypes = [
          'video/mp4;codecs=avc1,mp4a.40.2',
          'video/mp4',
          'video/webm;codecs=vp9,opus',
          'video/webm;codecs=vp8,opus',
          'video/webm'
      ];
      
      let mimeType = mimeTypes.find(t => MediaRecorder.isTypeSupported(t)) || '';
      
      const recorder = new MediaRecorder(mediaStream, {
        mimeType,
        videoBitsPerSecond: 8000000 // 8 Mbps for good quality
      });

      const chunks: Blob[] = [];
      recorder.ondataavailable = e => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = () => {
        const resultBlob = new Blob(chunks, { type: mimeType || 'video/mp4' });
        const url = URL.createObjectURL(resultBlob);
        resolve({ url, mimeType });
      };

      let isRecording = true;

      const drawFrame = () => {
        if (!isRecording) return;
        const currentTime = audio.currentTime;
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.globalCompositeOperation = 'source-over';
        ctx.shadowBlur = 0;
        ctx.drawImage(img, 0, 0);

        const activeSegment = timing.find(t => currentTime >= t.startTime && currentTime <= t.endTime);
        if (activeSegment && activeSegment.annotationType !== 'none') {
            const box = activeSegment.box_2d;
            const y = (box[0] / 1000) * canvas.height;
            const x = (box[1] / 1000) * canvas.width;
            const h = ((box[2] - box[0]) / 1000) * canvas.height;
            const w = ((box[3] - box[1]) / 1000) * canvas.width;

            const animDuration = 0.4;
            const animProgress = Math.min(1, Math.max(0, (currentTime - activeSegment.startTime) / animDuration));
            const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
            const p = easeOut(animProgress);
            
            const type = activeSegment.annotationType;

            if (type === 'highlight') {
              ctx.fillStyle = 'rgba(250, 210, 0, 0.4)';
              ctx.globalCompositeOperation = 'multiply';
              ctx.fillRect(x, y, w * p, h);
              ctx.globalCompositeOperation = 'source-over';
            } else if (type === 'underline') {
              ctx.strokeStyle = '#ef4444';
              ctx.lineWidth = Math.max(4, canvas.height * 0.005);
              ctx.lineCap = 'round';
              ctx.shadowColor = 'rgba(239, 68, 68, 0.8)';
              ctx.shadowBlur = 10;
              ctx.beginPath();
              ctx.moveTo(x, y + h + 5);
              ctx.lineTo(x + w * p, y + h + 5);
              ctx.stroke();
            } else if (type === 'circle') {
               ctx.strokeStyle = '#ef4444';
               ctx.lineWidth = Math.max(4, canvas.height * 0.005);
               ctx.lineCap = 'round';
               ctx.shadowColor = 'rgba(239, 68, 68, 0.8)';
               ctx.shadowBlur = 10;
               ctx.beginPath();
               
               const cx = x + w/2;
               const cy = y + h/2;
               const rx = Math.max(20, w/2 + 16);
               const ry = Math.max(20, h/2 + 16);
               
               if (ctx.ellipse) {
                 ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2 * p);
               } else {
                 ctx.arc(cx, cy, Math.max(rx, ry), 0, Math.PI * 2 * p);
               }
               ctx.stroke();
            } else if (type === 'arrow') {
              const startX = Math.min(canvas.width - 50, x + w + 80);
              const startY = Math.min(canvas.height - 50, y + h + 80);
              const targetX = x;
              const targetY = y;
              
              const currentX = startX + (targetX - startX) * p;
              const currentY = startY + (targetY - startY) * p;

              ctx.strokeStyle = '#ef4444';
              ctx.lineWidth = Math.max(6, canvas.height * 0.006);
              ctx.lineCap = 'round';
              ctx.lineJoin = 'round';
              ctx.shadowColor = 'rgba(239, 68, 68, 0.8)';
              ctx.shadowBlur = 10;
              
              ctx.beginPath();
              ctx.moveTo(startX, startY);
              ctx.lineTo(currentX, currentY);
              ctx.stroke();
              
              if (p > 0.5) {
                const headProgress = (p - 0.5) * 2;
                const angle = Math.atan2(targetY - startY, targetX - startX);
                const headlen = Math.max(25, canvas.height * 0.02) * headProgress;
                
                ctx.beginPath();
                ctx.moveTo(currentX, currentY);
                ctx.lineTo(currentX - headlen * Math.cos(angle - Math.PI / 6), currentY - headlen * Math.sin(angle - Math.PI / 6));
                ctx.moveTo(currentX, currentY);
                ctx.lineTo(currentX - headlen * Math.cos(angle + Math.PI / 6), currentY - headlen * Math.sin(angle + Math.PI / 6));
                ctx.stroke();
              }
            }
        }

        onProgress(currentTime / audio.duration);
        requestAnimationFrame(drawFrame);
      };

      audio.onplay = () => {
        recorder.start();
        requestAnimationFrame(drawFrame);
      };

      audio.onended = () => {
        isRecording = false;
        recorder.stop();
        audioCtx.close();
      };

      setTimeout(() => {
        audio.play().catch(err => {
          console.error("Audio play failed during export", err);
          reject(err);
        });
      }, 500);

    } catch (err) {
      reject(err);
    }
  });
}
