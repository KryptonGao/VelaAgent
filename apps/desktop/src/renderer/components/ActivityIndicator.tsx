import { useEffect, useRef } from "react";
import motion from "./dot-motion-loader.json";
import { tr } from "../locale";

type MotionScene = (typeof motion.scenes)[number];
type MotionCell = MotionScene["cells"][number];

/** Replays the supplied dot-matrix loader in the currently selected theme accent. */
export function ActivityIndicator({ label = tr("运行中", "Running") }: { label?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const scene = motion.scenes[0];
    if (!canvas || !context || !scene) return;

    let elapsed = 0;
    let lastFrame: number | null = null;
    let frame = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const phase = () => reducedMotion.matches ? 0.5 : (elapsed % motion.duration) / motion.duration;

    const draw = (progress: number) => {
      const width = canvas.getBoundingClientRect().width || 24;
      const dpr = window.devicePixelRatio || 1;
      const pixelWidth = Math.max(1, Math.round(width * dpr));
      const pixelHeight = Math.max(1, Math.round(width * scene.height / scene.width * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      const scale = pixelWidth / scene.width;
      context.scale(scale, scale);
      const accent = getComputedStyle(canvas).color || "#4f8cff";
      context.save();
      context.translate((motion.width - scene.width) / 2, (motion.height - scene.height) / 2);

      const drawCell = (item: MotionCell, size: number, alpha: number, glow: boolean) => {
        if (size <= 0 || alpha <= 0) return;
        context.save();
        context.globalAlpha = alpha;
        context.translate(item.x + (scene.cellSize - size) / 2, item.y + (scene.cellSize - size) / 2);
        context.beginPath();
        if (scene.polygon.length > 0) {
          scene.polygon.forEach((coordinate, index, polygon) => {
            if (index % 2 !== 0) return;
            if (index === 0) context.moveTo(coordinate * size, (polygon[index + 1] ?? 0) * size);
            else context.lineTo(coordinate * size, (polygon[index + 1] ?? 0) * size);
          });
          context.closePath();
        } else {
          context.roundRect(0, 0, size, size, Math.min(size / 2, scene.radius * size / scene.cellSize));
        }
        if (glow) {
          context.shadowColor = accent;
          context.shadowBlur = scene.glow * scale;
        }
        context.fillStyle = accent;
        context.fill();
        context.restore();
      };

      for (const item of scene.cells) {
        const position = progress * (item.samples.length - 1);
        const index = Math.min(item.samples.length - 2, Math.floor(position));
        const mix = position - index;
        const start = item.samples[index] ?? [0, 0, 0];
        const end = item.samples[index + 1] ?? start;
        const value = start.map((sample, sampleIndex) => sample + ((end[sampleIndex] ?? sample) - sample) * mix);
        drawCell(item, scene.cellSize, (value[2] ?? 0) * 0.18, false);
        if (item.active) drawCell(item, scene.cellSize * (value[1] ?? 0), value[0] ?? 0, true);
      }
      context.restore();
    };

    const tick = (now: number) => {
      if (lastFrame !== null) elapsed += Math.max(0, now - lastFrame) / 1000;
      lastFrame = now;
      draw(phase());
      frame = window.requestAnimationFrame(tick);
    };
    const syncMotion = () => {
      window.cancelAnimationFrame(frame);
      lastFrame = null;
      draw(phase());
      if (!reducedMotion.matches) {
        lastFrame = performance.now();
        frame = window.requestAnimationFrame(tick);
      }
    };

    const resizeObserver = new ResizeObserver(() => draw(phase()));
    resizeObserver.observe(canvas);
    const themeObserver = new MutationObserver(() => draw(phase()));
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-scheme", "data-theme"],
    });
    reducedMotion.addEventListener("change", syncMotion);
    syncMotion();

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      reducedMotion.removeEventListener("change", syncMotion);
    };
  }, []);

  return <canvas ref={canvasRef} className="tool-activity-loader" role="status" aria-label={label} />;
}
