// Size presets for widgets based on a 12-column grid with rowHeight=80

export interface SizePreset {
  id: string;
  name: string;
  gridW: number;
  gridH: number;
  description: string;
}

export const SIZE_PRESETS: SizePreset[] = [
  { id: 'small', name: 'Small', gridW: 2, gridH: 2, description: '2x2' },
  { id: 'medium', name: 'Medium', gridW: 4, gridH: 3, description: '4x3' },
  { id: 'large', name: 'Large', gridW: 6, gridH: 4, description: '6x4' },
  { id: 'wide', name: 'Wide', gridW: 6, gridH: 2, description: '6x2' },
  { id: 'tall', name: 'Tall', gridW: 4, gridH: 6, description: '4x6' },
  { id: 'full', name: 'Full Width', gridW: 12, gridH: 4, description: '12x4' },
];

export const DEFAULT_SIZE_PRESET = SIZE_PRESETS[1]; // Medium 4x3