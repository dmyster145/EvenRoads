import type { LaunchSource } from "@evenrealities/even_hub_sdk";
import type { CompanionTab } from "./contracts";

export type CompanionIconKey =
  | "home"
  | "hub"
  | "scroll"
  | "tap"
  | "doubleTap"
  | "info"
  | "saved"
  | "alert"
  | "trash";

export interface CompanionBanner {
  badge: string;
  title: string;
  copy: string;
}

export interface CompanionRow {
  icon: CompanionIconKey;
  title: string;
  subtitle: string;
}

export interface CompanionGlyphRow {
  glyph: string;
  meaning: string;
}

export interface GuideCardModel {
  title: string;
  bullets: string[];
}

export function formatScore(value: number): string {
  return Math.max(0, Math.floor(value)).toString().padStart(2, "0");
}

export function defaultTabForLaunchSource(source: LaunchSource | null): CompanionTab {
  return source === "glassesMenu" ? "controls" : "overview";
}

export function buildLaunchSourceBanner(source: LaunchSource | null): CompanionBanner | null {
  if (source === "glassesMenu") {
    return {
      badge: "Glasses Menu",
      title: "Opened from glasses menu",
      copy: "The game is already live in-glasses. Keep this screen nearby for the gesture map, board legend, and reset controls.",
    };
  }

  if (source === "appMenu") {
    return {
      badge: "App Menu",
      title: "Opened from Even App menu",
      copy: "Use this screen as your quick reference, then jump into the glasses menu when you are ready for direct play.",
    };
  }

  return null;
}

export function buildOverviewQuickStart(source: LaunchSource | null): CompanionRow[] {
  if (source === "glassesMenu") {
    return [
      {
        icon: "hub",
        title: "Game already running",
        subtitle: "Inputs are live on the glasses now. This page is your secondary HUD and rules sheet.",
      },
      {
        icon: "tap",
        title: "Tap to hop",
        subtitle: "Tap moves up one row. Double tap also hops while alive and restarts after a crash.",
      },
      {
        icon: "scroll",
        title: "Scroll to strafe",
        subtitle: "Scroll up moves right. Scroll down moves left. There is no down move in-game.",
      },
    ];
  }

  if (source === "appMenu") {
    return [
      {
        icon: "home",
        title: "Start from the phone shell",
        subtitle: "Use this page to learn the controls and flow before opening the glasses menu for direct play.",
      },
      {
        icon: "tap",
        title: "Learn the hop cadence",
        subtitle: "Tap advances one row. Double tap is the same while alive, but becomes restart after a crash.",
      },
      {
        icon: "hub",
        title: "Move to the glasses menu",
        subtitle: "The fastest path to live play is launching HoppyRoads from the glasses menu once you know the inputs.",
      },
    ];
  }

  return [
    {
      icon: "home",
      title: "Read the essentials",
      subtitle: "This companion shell summarizes controls, glyphs, hazards, and score state for the current build.",
    },
    {
      icon: "tap",
      title: "Tap to climb",
      subtitle: "Hops only move upward. Horizontal positioning comes from scroll gestures before each opening.",
    },
    {
      icon: "scroll",
      title: "Scroll to line up",
      subtitle: "Watch lane motion early and align with safe cells before you commit to the next hop.",
    },
  ];
}

export function buildControlRows(): CompanionRow[] {
  return [
    {
      icon: "scroll",
      title: "Scroll Up",
      subtitle: "Moves right by one column.",
    },
    {
      icon: "scroll",
      title: "Scroll Down",
      subtitle: "Moves left by one column.",
    },
    {
      icon: "tap",
      title: "Tap",
      subtitle: "Hops up one row.",
    },
    {
      icon: "doubleTap",
      title: "Double Tap",
      subtitle: "Acts like hop while running and restart after a crash.",
    },
  ];
}

export function buildBoardGlyphRows(): CompanionGlyphRow[] {
  return [
    { glyph: "▲", meaning: "Player while alive" },
    { glyph: "※", meaning: "Player marker after a crash" },
    { glyph: "▷ ◁ ◈", meaning: "Traffic markers showing lane flow" },
    { glyph: "▒", meaning: "Open road cell" },
    { glyph: "▩", meaning: "Solid blocker that cannot be entered" },
    { glyph: "□", meaning: "Bridge-safe cell and part of home/goal patterns" },
  ];
}

export function buildLaunchHint(source: LaunchSource | null): string {
  if (source === "glassesMenu") {
    return "Glasses-menu launch detected. Use this page as a live legend while the run is active on the device.";
  }
  if (source === "appMenu") {
    return "App-menu launch detected. Review controls here, then switch to the glasses menu when you want direct in-glasses play.";
  }
  return "Launch-source detection is available when the SDK reports whether the app opened from the phone app or the glasses menu.";
}

export function buildGuideCards(): GuideCardModel[] {
  return [
    {
      title: "Objective",
      bullets: [
        "Start on the bottom row and reach the goal row without colliding with traffic.",
        "Each successful crossing respawns you at the home row and increments both score and level.",
      ],
    },
    {
      title: "Gameplay Loop",
      bullets: [
        "Align with safe openings using horizontal movement.",
        "Hop upward one row at a time.",
        "Read the lane direction markers early because adjacent lanes alternate flow.",
      ],
    },
    {
      title: "Rules & Hazards",
      bullets: [
        "Traffic on non-bridge road cells causes an immediate crash.",
        "Bridge cells stay safe even when traffic visually overlaps them.",
        "Solid blockers are impassable, and the game only supports left, right, and up movement.",
      ],
    },
    {
      title: "Progression & Persistence",
      bullets: [
        "Each crossing increases the level and speeds up lane updates down to a minimum interval floor.",
        "Only best score persists between launches. Current position, level, and board layout do not resume.",
        "Reset Scores clears the live run and stored best score together.",
      ],
    },
    {
      title: "Practical Tips",
      bullets: [
        "Move horizontally early so you can commit upward when a safe bridge or opening appears.",
        "On faster levels, anticipate the next lane instead of reacting only to the current one.",
      ],
    },
  ];
}
