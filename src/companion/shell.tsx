import {
  type ReactElement,
  StrictMode,
  startTransition,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import {
  AppShell,
  Badge,
  Card,
  CTAGroup,
  ConfirmDialog,
  ListItem,
  Page,
  ScreenHeader,
  SectionHeader,
  SettingsGroup,
  Toast,
} from "even-toolkit/web";
import {
  IcEditTrash,
  IcGuideDoubleTap,
  IcGuideSingleTap,
  IcGuideSwip,
  IcMenuEvenHub,
  IcMenuHome,
  IcStatusAlert,
  IcStatusInfo,
  IcStatusSaved,
} from "even-toolkit/web/icons/svg-icons";
import type { CompanionSnapshot, CompanionTab, ResetBestScoreResult } from "./contracts";
import type { CompanionRuntimeStore } from "./runtime";
import { createCompanionRuntimeStore, resetBestScore } from "./runtime";
import {
  buildBoardGlyphRows,
  buildControlRows,
  buildGuideCards,
  buildLaunchHint,
  buildLaunchSourceBanner,
  buildOverviewQuickStart,
  defaultTabForLaunchSource,
  formatScore,
  type CompanionGlyphRow,
  type CompanionIconKey,
  type CompanionRow,
} from "./view-model";

const NAV_ITEMS: { id: CompanionTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "controls", label: "Controls" },
  { id: "guide", label: "Guide" },
];

function borderClassName(): string {
  return "border border-border";
}

function badgeVariantForRunState(runState: string): "positive" | "negative" | "accent" | "neutral" {
  if (runState === "CRASHED!") return "negative";
  if (runState === "PAUSED") return "accent";
  return "positive";
}

function iconChipClassName(icon: CompanionIconKey): string {
  if (icon === "trash" || icon === "alert") return "bg-negative-alpha text-negative";
  if (icon === "saved") return "bg-positive-alpha text-positive";
  return "bg-accent-alpha text-text";
}

function IconForKey({ icon }: { icon: CompanionIconKey }): ReactElement {
  const common = { width: 18, height: 18 };
  if (icon === "home") return <IcMenuHome {...common} />;
  if (icon === "hub") return <IcMenuEvenHub {...common} />;
  if (icon === "scroll") return <IcGuideSwip {...common} />;
  if (icon === "tap") return <IcGuideSingleTap {...common} />;
  if (icon === "doubleTap") return <IcGuideDoubleTap {...common} />;
  if (icon === "saved") return <IcStatusSaved {...common} />;
  if (icon === "alert") return <IcStatusAlert {...common} />;
  if (icon === "trash") return <IcEditTrash {...common} />;
  return <IcStatusInfo {...common} />;
}

function SourceBadge({ snapshot }: { snapshot: CompanionSnapshot }): ReactElement | null {
  const label =
    snapshot.launchSource === "glassesMenu"
      ? "Glasses"
      : snapshot.launchSource === "appMenu"
        ? "App"
        : null;
  if (!label) return null;
  const variant = "accent";
  return <Badge variant={variant}>{label}</Badge>;
}

function BannerCard({ snapshot }: { snapshot: CompanionSnapshot }): ReactElement | null {
  const banner = buildLaunchSourceBanner(snapshot.launchSource);
  if (!banner) return null;

  return (
    <Card
      padding="default"
      className={`mb-4 bg-surface shadow-[0_8px_24px_rgba(0,0,0,0.06)] ${borderClassName()}`}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="inline-flex h-7 items-center rounded-[6px] bg-accent-warning px-2 text-[13px] tracking-[-0.13px] text-text">
          {banner.badge}
        </span>
        <span className="text-[11px] tracking-[-0.11px] text-text-dim">Launch Context</span>
      </div>
      <h2 className="text-[17px] tracking-[-0.17px] font-normal text-text">{banner.title}</h2>
      <p className="mt-1 text-[13px] tracking-[-0.13px] text-text-dim">{banner.copy}</p>
    </Card>
  );
}

function IntroCard({ snapshot }: { snapshot: CompanionSnapshot }): ReactElement {
  return (
    <Card
      padding="default"
      className={`mb-4 bg-surface shadow-[0_10px_24px_rgba(0,0,0,0.05)] ${borderClassName()}`}
    >
      <div className="mb-4 h-1 rounded-full bg-surface-lighter" />
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-[6px] bg-accent-alpha text-text">
            <IcMenuEvenHub width={20} height={20} />
          </span>
          <div>
            <p className="text-[11px] tracking-[-0.11px] uppercase text-text-dim">Even Hub Companion</p>
            <h1 className="text-[20px] tracking-[-0.6px] font-normal text-text">HoppyRoads</h1>
          </div>
        </div>
        <SourceBadge snapshot={snapshot} />
      </div>
      <p className="mt-3 text-[15px] tracking-[-0.15px] text-text-dim">
        Road crossing for Even Realities G2 with live score sync, control reference, and reset actions.
      </p>
    </Card>
  );
}

function SettingsRows({
  label,
  rows,
}: {
  label: string;
  rows: CompanionRow[];
}): ReactElement {
  return (
    <SettingsGroup label={label}>
      {rows.map((row) => (
        <ListItem
          key={row.title}
          title={row.title}
          subtitle={row.subtitle}
          leading={
            <span
              className={`flex h-8 w-8 items-center justify-center rounded-[6px] ${iconChipClassName(row.icon)}`}
            >
              <IconForKey icon={row.icon} />
            </span>
          }
        />
      ))}
    </SettingsGroup>
  );
}

function GlyphRows({ rows }: { rows: CompanionGlyphRow[] }): ReactElement {
  return (
    <SettingsGroup label="Board legend">
      {rows.map((row) => (
        <ListItem
          key={row.glyph}
          title={row.meaning}
          leading={
            <code className="flex h-8 min-w-8 items-center justify-center rounded-[6px] bg-accent-alpha px-2 font-mono text-[15px] tracking-[-0.15px] text-text">
              {row.glyph}
            </code>
          }
        />
      ))}
    </SettingsGroup>
  );
}

function RunSummaryGrid({ snapshot }: { snapshot: CompanionSnapshot }): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-3">
      <Card
        padding="default"
        className={`bg-accent-warning shadow-[0_8px_20px_rgba(0,0,0,0.04)] ${borderClassName()}`}
      >
        <p className="text-[11px] tracking-[-0.11px] uppercase text-text-dim">Live Score</p>
        <p className="mt-3 text-[48px] leading-none tracking-[-1.2px] text-text">
          {formatScore(snapshot.score)}
        </p>
        <p className="mt-3 text-[13px] tracking-[-0.13px] text-text-dim">
          {snapshot.crossedMessage ?? "Current run"}
        </p>
      </Card>

      <Card
        padding="default"
        className={`bg-surface shadow-[0_8px_20px_rgba(0,0,0,0.04)] ${borderClassName()}`}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] tracking-[-0.11px] uppercase text-text-dim">Best Score</p>
          <Badge variant={badgeVariantForRunState(snapshot.runState)}>{snapshot.runState}</Badge>
        </div>
        <p className="mt-3 text-[48px] leading-none tracking-[-1.2px] text-text">
          {formatScore(snapshot.bestScore)}
        </p>
        <p className="mt-3 text-[13px] tracking-[-0.13px] text-text-dim">Saved across sessions</p>
      </Card>
    </div>
  );
}

function CompanionTabBar({
  activeTab,
  onNavigate,
}: {
  activeTab: CompanionTab;
  onNavigate: (nextTabId: string) => void;
}): ReactElement {
  return (
    <Card
      padding="sm"
      className={`bg-surface shadow-[0_8px_20px_rgba(0,0,0,0.04)] ${borderClassName()}`}
    >
      <div className="grid grid-cols-3 gap-1">
        {NAV_ITEMS.map((item) => {
          const active = item.id === activeTab;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              className={
                active
                  ? "h-11 rounded-[6px] bg-accent text-text-highlight shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                  : "h-11 rounded-[6px] text-text-dim transition-colors hover:bg-surface-light hover:text-text"
              }
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function OverviewTab({
  snapshot,
  onRequestReset,
}: {
  snapshot: CompanionSnapshot;
  onRequestReset: () => void;
}): ReactElement {
  return (
    <>
      <ScreenHeader
        title="Overview"
        subtitle="Current score, best score, and the fastest path back into play."
      />

      <SectionHeader title="Run Summary" />
      <RunSummaryGrid snapshot={snapshot} />

      <SectionHeader title="Quick Start" />
      <SettingsRows label="Start here" rows={buildOverviewQuickStart(snapshot.launchSource)} />

      <SectionHeader title="Reset" />
      <Card
        padding="default"
        className={`mb-3 bg-surface shadow-[0_8px_20px_rgba(0,0,0,0.04)] ${borderClassName()}`}
      >
        <p className="text-[15px] tracking-[-0.15px] text-text">
          Reset clears the live run and the persisted best score together.
        </p>
        <p className="mt-1 text-[13px] tracking-[-0.13px] text-text-dim">
          Use this when you want a clean scoreboard before handing the glasses to someone else.
        </p>
      </Card>

      <CTAGroup
        actions={[{ label: "Reset Scores", onClick: onRequestReset, variant: "danger" }]}
        className="px-0"
      />
    </>
  );
}

function ControlsTab({ snapshot }: { snapshot: CompanionSnapshot }): ReactElement {
  return (
    <>
      <ScreenHeader
        title="Controls"
        subtitle="Gesture map, glyph legend, and launch-specific guidance."
      />

      <SectionHeader title="Gesture Map" />
      <SettingsRows label="Glasses gestures" rows={buildControlRows()} />

      <SectionHeader title="Board Glyphs" />
      <GlyphRows rows={buildBoardGlyphRows()} />

      <SectionHeader title="Launch Hint" />
      <Card
        padding="default"
        className={`shadow-[0_8px_20px_rgba(0,0,0,0.04)] ${borderClassName()}`}
      >
        <div className="mb-2 flex items-center gap-2 text-text">
          <IcStatusInfo width={16} height={16} />
          <span className="text-[13px] tracking-[-0.13px] text-text-dim">Context</span>
        </div>
        <p className="text-[15px] tracking-[-0.15px] text-text">{buildLaunchHint(snapshot.launchSource)}</p>
      </Card>
    </>
  );
}

function GuideTab(): ReactElement {
  return (
    <>
      <ScreenHeader
        title="Guide"
        subtitle="Objective, hazards, progression, and practical play tips."
      />

      {buildGuideCards().map((card) => (
        <div key={card.title}>
          <SectionHeader title={card.title} />
          <Card
            padding="default"
            className={`shadow-[0_8px_20px_rgba(0,0,0,0.04)] ${borderClassName()}`}
          >
            <ul className="space-y-2 pl-5 text-[15px] tracking-[-0.15px] text-text">
              {card.bullets.map((bullet) => (
                <li key={bullet}>{bullet}</li>
              ))}
            </ul>
          </Card>
        </div>
      ))}
    </>
  );
}

function CompanionShell({ runtime }: { runtime: CompanionRuntimeStore }): ReactElement {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  const [activeTab, setActiveTab] = useState<CompanionTab>(() =>
    defaultTabForLaunchSource(snapshot.launchSource),
  );
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [toast, setToast] = useState<ResetBestScoreResult | null>(null);

  useEffect(() => {
    startTransition(() => {
      setActiveTab(defaultTabForLaunchSource(snapshot.launchSource));
    });
  }, [snapshot.launchSource]);

  const dismissToast = useEffectEvent(() => {
    setToast(null);
  });

  const handleNavigate = useEffectEvent((nextTabId: string) => {
    if (nextTabId !== "overview" && nextTabId !== "controls" && nextTabId !== "guide") return;
    startTransition(() => {
      setActiveTab(nextTabId);
    });
  });

  const handleConfirmReset = useEffectEvent(() => {
    setToast(resetBestScore());
  });

  useEffect(() => {
    if (!toast || typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      dismissToast();
    }, 2600);
    return () => {
      window.clearTimeout(timer);
    };
  }, [toast, dismissToast]);

  return (
    <>
      <AppShell
        className="bg-bg"
        header={
          <div className="mx-auto w-full max-w-[760px] px-3 pt-3">
            <CompanionTabBar activeTab={activeTab} onNavigate={handleNavigate} />
          </div>
        }
      >
        <Page className="mx-auto w-full max-w-[760px] px-3 pb-12 pt-4">
          <IntroCard snapshot={snapshot} />
          <BannerCard snapshot={snapshot} />
          {activeTab === "overview" ? (
            <OverviewTab snapshot={snapshot} onRequestReset={() => setConfirmResetOpen(true)} />
          ) : activeTab === "controls" ? (
            <ControlsTab snapshot={snapshot} />
          ) : (
            <GuideTab />
          )}
        </Page>
      </AppShell>

      <ConfirmDialog
        open={confirmResetOpen}
        onClose={() => setConfirmResetOpen(false)}
        onConfirm={handleConfirmReset}
        title="Reset scores?"
        description="This clears both the live run and the saved best score."
        confirmLabel="Reset"
        cancelLabel="Cancel"
        variant="danger"
      />

      {toast ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-3">
          <Toast
            className="pointer-events-auto w-full max-w-[440px]"
            message={toast.message}
            variant={toast.variant}
            action={
              <button
                type="button"
                className="text-[13px] tracking-[-0.13px] text-text-dim"
                onClick={() => setToast(null)}
              >
                Dismiss
              </button>
            }
          />
        </div>
      ) : null}
    </>
  );
}

export function mountCompanionShell(): void {
  if (typeof document === "undefined") return;
  const rootEl = document.getElementById("companion-root");
  if (!(rootEl instanceof HTMLElement)) return;

  const runtime = createCompanionRuntimeStore();
  const root = createRoot(rootEl);
  root.render(
    <StrictMode>
      <CompanionShell runtime={runtime} />
    </StrictMode>,
  );
}
