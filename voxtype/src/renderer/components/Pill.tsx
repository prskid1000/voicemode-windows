import { useMemo } from 'react';
import type { PillState } from '@shared/types';

interface PillProps {
  state: PillState;
  waveform: number[];
}

/*
 * Liquid-mercury orb: a 28px circle that morphs into a
 * horizontal pill only during recording. Every other state
 * is a compact, animated circle with a unique icon.
 */
export default function Pill({ state, waveform }: PillProps) {
  const isRecording = state === 'recording';

  const shellClass = useMemo(() => {
    const base = 'pill-shell flex items-center justify-center rounded-full backdrop-blur-xl';
    if (isRecording)
      return `${base} h-7 px-2.5 bg-[#1a0a0a]/90 border border-red-500/30 animate-rec-glow`;
    return `${base} w-7 h-7 border`;
  }, [isRecording]);

  const stateStyle = useMemo(() => {
    switch (state) {
      case 'idle':       return 'bg-[#0d1117]/85 border-white/[0.06] animate-aurora';
      case 'processing': return 'bg-[#12100a]/90 border-amber-500/20';
      case 'enhancing':  return 'bg-[#0c0a14]/90 border-indigo-400/20';
      case 'typing':     return 'bg-[#06120d]/90 border-emerald-500/25';
      case 'error':      return 'bg-[#14080a]/90 border-red-400/25';
      default:           return '';
    }
  }, [state]);

  return (
    <div className="flex items-center justify-center w-full h-full">
      <div className={`${shellClass} ${isRecording ? '' : stateStyle}`}>
        {isRecording ? <RecordingContent bars={waveform} /> : <OrbIcon state={state} />}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════
   RECORDING — red dot + live waveform
   ═══════════════════════════════════════ */
function RecordingContent({ bars }: { bars: number[] }) {
  return (
    <div className="flex items-center gap-1.5">
      {/* Pulsing dot */}
      <div className="relative flex-shrink-0 w-2 h-2">
        <div className="absolute inset-0 rounded-full bg-red-500/40 animate-dot-ping" />
        <div className="absolute inset-[2px] rounded-full bg-red-400" />
      </div>
      {/* Waveform */}
      <div className="flex items-center gap-[1.5px] h-[18px]">
        {bars.map((v, i) => {
          const h = Math.max(2, v * 16);
          const o = 0.35 + v * 0.65;
          return (
            <div
              key={i}
              className="w-[1.5px] rounded-full"
              style={{
                height: h,
                backgroundColor: `rgba(248,113,113,${o})`,
                transition: 'height 55ms ease-out, background-color 55ms ease-out',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════
   ORB ICONS — one per non-recording state
   ═══════════════════════════════════════ */
function OrbIcon({ state }: { state: PillState }) {
  switch (state) {
    case 'idle':       return <IdleOrb />;
    case 'processing': return <ProcessingOrb />;
    case 'enhancing':  return <EnhancingOrb />;
    case 'typing':     return <TypingOrb />;
    case 'error':      return <ErrorOrb />;
    default:           return null;
  }
}

/* ── Idle: concentric gradient rings, slow breathe ── */
function IdleOrb() {
  return (
    <div className="relative w-3 h-3 animate-fade-in">
      <div className="absolute inset-0 rounded-full bg-gradient-to-br from-slate-400/20 to-slate-600/10" />
      <div className="absolute inset-[2px] rounded-full bg-gradient-to-br from-slate-300/15 to-transparent" />
      <div className="absolute inset-[4px] rounded-full bg-slate-300/10" />
    </div>
  );
}

/* ── Processing: 3-dot orbital ── */
function ProcessingOrb() {
  return (
    <div className="w-[18px] h-[18px] animate-orbit animate-fade-in">
      <svg viewBox="0 0 18 18" className="w-full h-full">
        <circle cx="9" cy="2.5" r="1.8" fill="#f59e0b" opacity="1" />
        <circle cx="14.6" cy="12.5" r="1.4" fill="#f59e0b" opacity="0.5" />
        <circle cx="3.4" cy="12.5" r="1" fill="#f59e0b" opacity="0.2" />
      </svg>
    </div>
  );
}

/* ── Enhancing: 4-point sparkle ── */
function EnhancingOrb() {
  return (
    <div className="animate-twinkle animate-fade-in">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        {/* Vertical diamond */}
        <path d="M12 2 L13.5 10.5 L12 19 L10.5 10.5Z" fill="#a78bfa" opacity="0.9" />
        {/* Horizontal diamond */}
        <path d="M3 10.5 L10.5 9 L21 10.5 L10.5 12Z" fill="#818cf8" opacity="0.7" />
        {/* Center flare */}
        <circle cx="12" cy="10.5" r="1.5" fill="#c4b5fd" />
      </svg>
    </div>
  );
}

/* ── Typing: animated check stroke ── */
function TypingOrb() {
  return (
    <div className="animate-fade-in">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
        <path
          d="M4 12.5 L9.5 18 L20 6"
          stroke="#34d399"
          strokeWidth="2.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="animate-draw-check"
        />
      </svg>
    </div>
  );
}

/* ── Error: zap bolt ── */
function ErrorOrb() {
  return (
    <div className="animate-jolt animate-fade-in">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
        <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="#f87171" />
      </svg>
    </div>
  );
}
