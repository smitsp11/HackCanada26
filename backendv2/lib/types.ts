export type RepairStep = {
  step: number;
  category: string;
  action: string;
  caution?: string;
  visual_description?: string;
};

export type LocalizationPlan = {
  targetLabel: string;
  targetDescription: string;
  countHint?: number;
  contextObjects: string[];
  overlayText: string;
  groupTargets: boolean;
};

export type PixelBox = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type LocalizationResult = {
  found: boolean;
  targetLabel?: string;
  box2d?: [number, number, number, number];
  pixelBox?: PixelBox;
};