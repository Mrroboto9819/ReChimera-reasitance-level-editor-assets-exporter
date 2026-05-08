import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { ExtractedSound } from "./api";

interface SoundPlayerProps {
  


  nowPlaying: NowPlaying | null;
  
  onClose: () => void;
  
  onLog?: (level: "info" | "ok" | "warn" | "error", text: string) => void;
}

export interface NowPlaying {
  
  name: string;
  

  source: string;
  



  audio: HTMLAudioElement;
  

  blobUrl: string;
  

  entry: ExtractedSound;
}

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
















export function SoundPlayer({ nowPlaying, onClose, onLog }: SoundPlayerProps) {
  const [paused, setPaused] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [exporting, setExporting] = useState(false);
  
  
  
  const seekingRef = useRef(false);

  const audio = nowPlaying?.audio ?? null;

  useEffect(() => {
    if (!audio) {
      setPaused(true);
      setCurrentTime(0);
      setDuration(0);
      return;
    }
    const onPlay = () => setPaused(false);
    const onPause = () => setPaused(true);
    const onTimeUpdate = () => {
      if (!seekingRef.current) setCurrentTime(audio.currentTime);
    };
    const onDurationChange = () => setDuration(audio.duration || 0);
    const onEnded = () => {
      setPaused(true);
      setCurrentTime(0);
    };
    const onVolumeChange = () => setVolume(audio.volume);

    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("volumechange", onVolumeChange);

    
    
    setPaused(audio.paused);
    setCurrentTime(audio.currentTime);
    setDuration(audio.duration || 0);
    setVolume(audio.volume);

    return () => {
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("volumechange", onVolumeChange);
    };
  }, [audio]);

  if (!nowPlaying) return null;

  const togglePlay = () => {
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch((e) => onLog?.("error", `Audio play failed: ${e}`));
    } else {
      audio.pause();
    }
  };

  const onSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!audio || !Number.isFinite(audio.duration)) return;
    const t = Number(e.target.value);
    seekingRef.current = true;
    audio.currentTime = t;
    setCurrentTime(t);
  };
  const onSeekEnd = () => {
    seekingRef.current = false;
  };

  const onVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!audio) return;
    const v = Number(e.target.value);
    audio.volume = v;
  };

  const handleExport = async () => {
    if (!nowPlaying || exporting) return;
    setExporting(true);
    try {
      
      
      
      const stem = nowPlaying.name
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(/\s+/g, "_")
        .slice(0, 80) || "sound";
      const path = await save({
        title: "Export sound as WAV",
        defaultPath: `${stem}.wav`,
        filters: [{ name: "WAVE audio", extensions: ["wav"] }],
      });
      if (typeof path !== "string") {
        onLog?.("info", "Sound export cancelled");
        return;
      }
      
      const bin = atob(nowPlaying.entry.wav_b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await invoke<void>("write_bytes", {
        path,
        bytes: Array.from(bytes),
      });
      onLog?.(
        "ok",
        `Exported ${stem}.wav (${(bytes.length / 1024).toFixed(1)} KB)`,
      );
    } catch (e) {
      onLog?.("error", `Sound export failed: ${e}`);
    } finally {
      setExporting(false);
    }
  };

  const progressMax = duration > 0 ? duration : 1;
  const channels = nowPlaying.entry.channels;
  const channelLabel =
    channels === 1 ? "mono" : channels === 2 ? "stereo" : `${channels}ch`;
  const meta = `${nowPlaying.source} · ${channelLabel} · ${nowPlaying.entry.sample_rate} Hz`;

  return (
    <div className="sound-player" role="region" aria-label="Sound player">
      <button
        type="button"
        className="sp-toggle"
        onClick={togglePlay}
        title={paused ? "Play" : "Pause"}
      >
        {paused ? "▶" : "❚❚"}
      </button>
      <div className="sp-info">
        <div className="sp-name" title={nowPlaying.name}>
          {nowPlaying.name}
        </div>
        <div className="sp-meta" title={meta}>
          {meta}
        </div>
      </div>
      <span className="sp-time mono small">{fmtTime(currentTime)}</span>
      <input
        type="range"
        className="sp-progress"
        min={0}
        max={progressMax}
        step={0.01}
        value={Math.min(currentTime, progressMax)}
        onChange={onSeek}
        onMouseUp={onSeekEnd}
        onTouchEnd={onSeekEnd}
        disabled={!Number.isFinite(duration) || duration === 0}
      />
      <span className="sp-time mono small">{fmtTime(duration)}</span>
      <span className="sp-volume-icon" aria-hidden>
        {volume === 0 ? "🔇" : volume < 0.5 ? "🔉" : "🔊"}
      </span>
      <input
        type="range"
        className="sp-volume"
        min={0}
        max={1}
        step={0.01}
        value={volume}
        onChange={onVolume}
        title={`Volume ${Math.round(volume * 100)}%`}
      />
      <button
        type="button"
        className="sp-action"
        onClick={handleExport}
        disabled={exporting}
        title="Save as .wav"
      >
        {exporting ? "…" : "⤓"}
      </button>
      <button
        type="button"
        className="sp-close"
        onClick={onClose}
        title="Close player"
        aria-label="Close player"
      >
        ×
      </button>
    </div>
  );
}
