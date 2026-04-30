export async function extractImagesFromPdf(file: File): Promise<string[]> {
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;
  const images: string[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    // Increase scale for better image quality (needed for Gemini to read text clearly)
    const viewport = page.getViewport({ scale: 2.0 });

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    if (!context) {
      throw new Error('Canvas context not supported');
    }

    canvas.height = viewport.height;
    canvas.width = viewport.width;

    await page.render({
      canvasContext: context as any,
      viewport: viewport as any,
    } as any).promise;

    // Convert canvas to base64 jpeg
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    // Remove the data URI prefix (e.g., "data:image/jpeg;base64,") for Gemini
    const base64Data = dataUrl.split(',')[1];
    images.push(base64Data);
  }

  return images;
}
