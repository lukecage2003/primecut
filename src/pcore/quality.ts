/** P-CORE render quality levels (pure; shared by the renderer UI and the render engine). */
export type PCoreQuality = 'preview' | 'standard' | 'high' | 'final';

/**
 * Quality levels. renderScale = internal render size (supersampling, then an alpha-correct
 * downscale); particles = particle density; crf/cpuUsed = VP9 encoding effort.
 */
export const PCORE_QUALITY: Record<PCoreQuality, { label: string; renderScale: number; particles: number; crf: number; cpuUsed: number; deadline: 'realtime' | 'good' }> = {
  preview: { label: 'Preview', renderScale: 0.5, particles: 0.5, crf: 34, cpuUsed: 8, deadline: 'realtime' },
  standard: { label: 'Standard', renderScale: 1, particles: 1, crf: 24, cpuUsed: 4, deadline: 'good' },
  high: { label: 'High Quality', renderScale: 1.5, particles: 1.25, crf: 20, cpuUsed: 3, deadline: 'good' },
  final: { label: 'Final Render', renderScale: 2, particles: 1.5, crf: 16, cpuUsed: 2, deadline: 'good' },
};
