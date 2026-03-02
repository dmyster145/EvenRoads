export type RenderGlyphProfile = "device" | "simulator";

const DISPLAY_PROFILE_STORAGE_KEY = "evenroads.displayProfile";

function normalizeProfile(raw: string | null | undefined): RenderGlyphProfile | null {
  if (!raw) return null;
  const value = raw.trim().toLowerCase();
  if (value === "device" || value === "hardware" || value === "glasses") {
    return "device";
  }
  if (value === "simulator" || value === "sim" || value === "preview") {
    return "simulator";
  }
  return null;
}

function profileFromSearch(search: string): RenderGlyphProfile | null {
  if (!search) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return null;
  }

  const directOverride =
    normalizeProfile(params.get("displayProfile")) ?? normalizeProfile(params.get("glyphProfile"));
  if (directOverride) return directOverride;

  const simulatorFlag = params.get("simulator");
  if (simulatorFlag === "1" || simulatorFlag === "true") return "simulator";
  if (simulatorFlag === "0" || simulatorFlag === "false") return "device";
  return null;
}

function profileFromLocalStorage(storage: Storage | undefined): RenderGlyphProfile | null {
  if (!storage) return null;
  try {
    return normalizeProfile(storage.getItem(DISPLAY_PROFILE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function getLocalStorageSafely(win: Window | undefined): Storage | undefined {
  if (!win) return undefined;
  try {
    return win.localStorage;
  } catch {
    return undefined;
  }
}

function looksLikeDesktopSimulator(userAgent: string): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod|android|mobile/.test(ua)) return false;
  if (/evenhub-simulator|evenhub simulator|electron/.test(ua)) return true;
  return /macintosh|windows nt|linux x86_64|x11/.test(ua);
}

function looksLikeDesktopPlatform(platform: string): boolean {
  if (!platform) return false;
  return /mac|win|linux|x11/i.test(platform);
}

function isLocalSimulatorHost(hostname: string): boolean {
  if (!hostname) return false;
  const host = hostname.trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isNonTouchRuntime(win: Window | undefined): boolean {
  const points = win?.navigator?.maxTouchPoints;
  return typeof points === "number" && points === 0;
}

function isMobileTouchRuntime(win: Window | undefined): boolean {
  const ua = win?.navigator?.userAgent ?? "";
  const mobileUa = /iphone|ipad|ipod|android|mobile/i.test(ua);
  if (!mobileUa) return false;
  const points = win?.navigator?.maxTouchPoints;
  if (typeof points === "number") return points > 0;
  // Some mobile webviews may not expose maxTouchPoints reliably.
  return true;
}

export function resolveRenderGlyphProfile(
  win: Window | undefined = typeof window !== "undefined" ? window : undefined,
): RenderGlyphProfile {
  const fromSearch = profileFromSearch(win?.location?.search ?? "");
  if (fromSearch) return fromSearch;

  const fromStorage = profileFromLocalStorage(getLocalStorageSafely(win));
  if (fromStorage) return fromStorage;

  if (isLocalSimulatorHost(win?.location?.hostname ?? "")) {
    return "simulator";
  }

  if (looksLikeDesktopPlatform(win?.navigator?.platform ?? "")) {
    return "simulator";
  }

  if (isNonTouchRuntime(win)) {
    return "simulator";
  }

  if (looksLikeDesktopSimulator(win?.navigator?.userAgent ?? "")) {
    return "simulator";
  }

  // Be conservative: only explicit mobile-touch runtimes are treated as hardware.
  // Everything else is simulator so screenshot workflows stay stable.
  return isMobileTouchRuntime(win) ? "device" : "simulator";
}
