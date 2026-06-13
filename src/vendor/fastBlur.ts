// @ts-nocheck
// Fast blur utility - placeholder implementation

const boxBlurCanvasRGB = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  iterations: number
): void => {
  // Basic box blur implementation via ImageData
  const imageData = ctx.getImageData(x, y, width, height);
  const data = imageData.data;
  const copy = new Uint8ClampedArray(data);

  for(let iter = 0; iter < (iterations || 1); iter++) {
    for(let py = 0; py < height; py++) {
      for(let px = 0; px < width; px++) {
        let r = 0, g = 0, b = 0, count = 0;

        for(let dy = -radius; dy <= radius; dy++) {
          for(let dx = -radius; dx <= radius; dx++) {
            const nx = px + dx;
            const ny = py + dy;
            if(nx >= 0 && nx < width && ny >= 0 && ny < height) {
              const idx = (ny * width + nx) * 4;
              r += copy[idx];
              g += copy[idx + 1];
              b += copy[idx + 2];
              count++;
            }
          }
        }

        const idx = (py * width + px) * 4;
        data[idx] = r / count;
        data[idx + 1] = g / count;
        data[idx + 2] = b / count;
      }
    }
  }

  ctx.putImageData(imageData, x, y);
};

export default boxBlurCanvasRGB;
export type { boxBlurCanvasRGB };
