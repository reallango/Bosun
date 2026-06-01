// Size presets for widgets based on a 24-column grid with rowHeight=50

export interface SizePreset {
  id: string;
  name: string;
  gridW: number;
  gridH: number;
  description: string;
}

export const SIZE_PRESETS: SizePreset[] = [
  // Small sizes
  { id: 'tiny', name: 'Tiny', gridW: 3, gridH: 2, description: '3x2' },
  { id: 'small', name: 'Small', gridW: 4, gridH: 3, description: '4x3' },
  { id: 'medium-sm', name: 'Medium (S)', gridW: 6, gridH: 4, description: '6x4' },
  // Medium sizes
  { id: 'medium', name: 'Medium', gridW: 8, gridH: 5, description: '8x5' },
  { id: 'medium-lg', name: 'Medium (L)', gridW: 12, gridH: 6, description: '12x6' },
  // Wide sizes
  { id: 'wide-sm', name: 'Wide (S)', gridW: 12, gridH: 3, description: '12x3' },
  { id: 'wide', name: 'Wide', gridW: 16, gridH: 4, description: '16x4' },
  { id: 'wide-lg', name: 'Wide (L)', gridW: 20, gridH: 5, description: '20x5' },
  // Large sizes
  { id: 'large', name: 'Large', gridW: 12, gridH: 8, description: '12x8' },
  { id: 'large-xl', name: 'Large (XL)', gridW: 16, gridH: 10, description: '16x10' },
  // Full width
  { id: 'full', name: 'Full Width', gridW: 24, gridH: 6, description: '24x6' },
  { id: 'full-tall', name: 'Full (Tall)', gridW: 24, gridH: 12, description: '24x12' },
];

export const DEFAULT_SIZE_PRESET = SIZE_PRESETS[2]; // Medium (S) 6x4