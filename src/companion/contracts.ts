import type { LaunchSource } from "@evenrealities/even_hub_sdk";

export const LAUNCH_SOURCE_EVENT = "hoppyroads:launch-source";
export const RESET_BEST_SCORE_EVENT = "hoppyroads:reset-best-score";

export type CompanionTab = "overview" | "controls" | "guide";

export interface LaunchSourceEventDetail {
  launchSource: LaunchSource;
}

export interface CompanionSnapshot {
  score: number;
  bestScore: number;
  runState: string;
  crossedMessage: string | null;
  launchSource: LaunchSource | null;
}

export interface ResetBestScoreResult {
  ok: boolean;
  message: string;
  variant: "info" | "error";
}
