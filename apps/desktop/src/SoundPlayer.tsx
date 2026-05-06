import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import type { ExtractedSound } from "./api";

interface SoundPlayerProps {
  /** Currently-playing sound, or null when nothing is loaded. The
   *  player UI is hidden in that case so it doesn't claim layout
   *  space when idle. */
  nowPlaying: NowPlaying | null;
  /** Stop playback + close the player bar. */
  onClose: () => void;
  /** Optional logger — surfaces export results in the bottom Console. */
  onLog?: (level: "info" | "ok" | "warn" | "error", text: string) => void;
}

export interface NowPlaying {
  /** Display name (sound entry name, e.g. "weapon_pistol_fire"). */
  name: string;
  /** Source bank filename — `resident_sound.dat`, `streaming_sound.dat`,
   *  etc. Shown as a secondary label. */
  source: string;
  /** Live `<audio>` element. The player subscribes to its events for
   *  progress / duration / ended. We deliberately keep ONE Audio per
   *  player session and reuse it across re-renders so playback
   *  doesn't restart on UI updates. */
  audio: HTMLAudioElement;
  /** Object URL backing the audio. Owned by the caller — the player
   *  doesn't revoke it on close (parent does). */
  blobUrl: string;
  /** The full extracted sound record. Used by the export action so we
   *  can re-decode the base64 WAV and write it to disk via Tauri. */
  entry: ExtractedSound;
}

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Bottom-of-app transport bar for the currently-playing extracted
 * sound. Replaces the previous "play in background, no UI" model with
 * a visible player carrying:
 *   - Play / pause toggle (also exposed on each Hierarchy row)
 *   - Seekable progress bar + time display
 *   - Volume slider
 *   - Export-as-WAV button (Tauri save dialog → write_bytes)
 *   - Close button (stops playback)
 *
 * Subscribes to the audio element's events instead of polling — this
 * keeps the player UI in sync regardless of whether playback was
 * started programmatically (Hierarchy click) or via the bar's own
 * controls.
 */
export function SoundPlayer({ nowPlaying, onClose, onLog }: SoundPlayerProps) {
  const [paused, setPaused] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [exporting, setExporting] = useState(false);
  // Local seek-in-progress flag — while the user is dragging the
  // progress slider, we suppress the audio's `timeupdate` events from
  // overwriting the slider's value. `mouseup` releases.
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

    // Sync initial state — the audio may have started playing before
    // this player mounted.
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
      // Build a filesystem-safe stem from the sound name. Same rules
      // as the GLB export path — strip Windows-illegal chars + clamp
      // length.
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
      // Decode the base64 WAV bytes once for write_bytes.
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
