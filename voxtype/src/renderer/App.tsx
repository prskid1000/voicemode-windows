import { useState, useEffect, useRef, useCallback } from 'react';
import Pill from './components/Pill';
import type { PillState } from '@shared/types';

declare global {
  interface Window {
    voxtype?: {
      onStartRecording: (cb: () => void) => () => void;
      onStopRecording: (cb: () => void) => () => void;
      onStateChange: (cb: (state: string, detail?: string) => void) => () => void;
      onError: (cb: (msg: string) => void) => () => void;
      sendAudioData: (buffer: ArrayBuffer) => void;
      getSettings: () => Promise<Record<string, unknown>>;
      setSettings: (s: Record<string, unknown>) => Promise<Record<string, unknown>>;
      cancel: () => void;
    };
  }
}

const BAR_COUNT = 20;
const SILENCE_THRESHOLD = 0.02;
const SILENCE_TIMEOUT_MS = 2000;

const DEMO_STATES: { state: PillState; duration: number }[] = [
  { state: 'idle', duration: 2500 },
  { state: 'recording', duration: 4000 },
  { state: 'processing', duration: 2000 },
  { state: 'enhancing', duration: 2000 },
  { state: 'typing', duration: 1500 },
  { state: 'error', duration: 2500 },
];

export default function App() {
  const [state, setState] = useState<PillState>('idle');
  const [waveform, setWaveform] = useState<number[]>(new Array(BAR_COUNT).fill(0));
  const [demoMode, setDemoMode] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const silenceStartRef = useRef<number>(0);
  const hasSpeechRef = useRef(false);
  const autoStopRef = useRef(true);

  // Persistent mic stream — pre-warmed on app start for instant recording
  const warmStreamRef = useRef<MediaStream | null>(null);
  const warmAudioCtxRef = useRef<AudioContext | null>(null);

  // Pre-warm mic on mount so getUserMedia latency is paid once
  useEffect(() => {
    if (!window.voxtype) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      warmStreamRef.current = stream;
      warmAudioCtxRef.current = new AudioContext();
      console.log('[VoxType] Mic pre-warmed');
    }).catch((err) => {
      console.error('[VoxType] Mic pre-warm failed:', err);
    });
    return () => {
      warmStreamRef.current?.getTracks().forEach((t) => t.stop());
      warmAudioCtxRef.current?.close();
    };
  }, []);

  // Demo mode
  useEffect(() => {
    if (!demoMode) return;
    let idx = 0;
    let waveInterval: number;
    let timeout: ReturnType<typeof setTimeout>;

    const cycleState = () => {
      const demo = DEMO_STATES[idx % DEMO_STATES.length];
      setState(demo.state);
      if (demo.state === 'recording') {
        waveInterval = window.setInterval(() => {
          setWaveform(Array.from({ length: BAR_COUNT }, () => Math.random() * 0.7 + 0.15));
        }, 60);
      } else {
        clearInterval(waveInterval);
        setWaveform(new Array(BAR_COUNT).fill(0));
      }
      idx++;
      timeout = setTimeout(cycleState, demo.duration);
    };
    cycleState();
    return () => { clearInterval(waveInterval); clearTimeout(timeout); };
  }, [demoMode]);

  useEffect(() => {
    if (!window.voxtype) { setDemoMode(true); return; }
    window.voxtype.getSettings().then((s) => {
      autoStopRef.current = s.autoStopOnSilence !== false;
    });
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    cancelAnimationFrame(animFrameRef.current);
    setWaveform(new Array(BAR_COUNT).fill(0));
    // Don't stop the warm stream — keep it alive for next recording
  }, []);

  const startRecording = useCallback(async () => {
    try {
      // Use pre-warmed stream or fallback to fresh request
      let stream = warmStreamRef.current;
      if (!stream || stream.getTracks().every((t) => t.readyState === 'ended')) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        warmStreamRef.current = stream;
      }

      // AudioContext — reuse or create
      let audioCtx = warmAudioCtxRef.current;
      if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new AudioContext();
        warmAudioCtxRef.current = audioCtx;
      }
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      silenceStartRef.current = 0;
      hasSpeechRef.current = false;

      const freqData = new Uint8Array(analyser.frequencyBinCount);
      const timeData = new Float32Array(analyser.fftSize);

      const updateWaveform = () => {
        analyser.getByteFrequencyData(freqData);
        const bars = Array.from({ length: BAR_COUNT }, (_, i) => {
          const idx = Math.floor((i / BAR_COUNT) * freqData.length);
          return freqData[idx] / 255;
        });
        setWaveform(bars);

        analyser.getFloatTimeDomainData(timeData);
        let sum = 0;
        for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
        const rms = Math.sqrt(sum / timeData.length);

        if (rms > SILENCE_THRESHOLD) {
          hasSpeechRef.current = true;
          silenceStartRef.current = 0;
        } else if (hasSpeechRef.current && autoStopRef.current) {
          if (silenceStartRef.current === 0) {
            silenceStartRef.current = performance.now();
          } else if (performance.now() - silenceStartRef.current > SILENCE_TIMEOUT_MS) {
            stopRecording();
            return;
          }
        }

        animFrameRef.current = requestAnimationFrame(updateWaveform);
      };
      updateWaveform();

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        source.disconnect();
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const buffer = await blob.arrayBuffer();
        window.voxtype?.sendAudioData(buffer);
      };
      recorder.start(100);
      mediaRecorderRef.current = recorder;
    } catch (err) {
      console.error('Failed to start recording:', err);
    }
  }, [stopRecording]);

  useEffect(() => {
    const api = window.voxtype;
    if (!api) return;
    setDemoMode(false);

    const unsubs = [
      api.onStartRecording(() => {
        api.getSettings().then((s) => { autoStopRef.current = s.autoStopOnSilence !== false; });
        startRecording();
      }),
      api.onStopRecording(() => stopRecording()),
      api.onStateChange((s) => setState(s as PillState)),
      api.onError(() => setState('error')),
    ];
    return () => unsubs.forEach((u) => u());
  }, [startRecording, stopRecording]);

  return <Pill state={state} waveform={waveform} />;
}
