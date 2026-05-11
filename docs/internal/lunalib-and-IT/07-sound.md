# 07 — Sound banks & streams

Source: `crates/lunalib/src/sound.rs`.

Two parallel pipelines depending on the title era:

| Game | Bank | Stream |
|---|---|---|
| RFOM | `ps3sound.dat` (V1) | `ps3soundstream.dat`, `ps3dialoguestream.<lang>.dat` |
| R2 / R3 / RCF | `resident_sound.dat` (V2), `resident_dialogue.<lang>.dat` | `streaming_sound.dat`, `streaming_dialogue.<lang>.dat` |

## SCREAM bank format

A SCREAM bank is itself an IGHW with a few characteristic sections:

| ID | Class | Notes |
|---|---|---|
| `0x21000` | `SoundBank` (open-ended) | Holds `SCREAMBankHeader` |
| `0x21010` | `SoundStreams` (V1) | Stream pointer table |
| `0x21100` | `SoundNames` (V1) / `SoundStreamsV2` | Collision — version-dependent |
| `0x21200` | `SoundNamesV2` (V2) / `Sounds` (V1) | Collision — version-dependent |
| `0x21300` | `SoundsV2` | V2 only |

We auto-detect V1 vs V2 by checking which sections are present. SCREAM
banks need a manual `Fixup` pass on certain pointers (defined in IT's
`serialize.cpp` and ported here) — sections with relative pointers get
rebased to the file's absolute address.

## In-bank PS-ADPCM

Each `Sound` entry references PS-ADPCM blocks inside the bank file. The
decoder walks 16-byte blocks producing 28 16-bit samples each, using
the standard two-tap predictor:

```rust
fn decode_block(src: &[u8; 16], samples: &mut [i16; 28], prev: &mut i16, ppr: &mut i16) {
    // header byte: shift (low 4 bits) + filter (high 4 bits)
    // 14 nibbles → samples, each refined by:
    //   sample = (raw << shift) + filter_a * prev + filter_b * ppr
}
```

Multi-channel sounds interleave by block (one block of channel 0, one
of channel 1, …). Output is always 16-bit signed PCM at the bank's
declared sample rate.

## Streaming containers

For sounds that don't fit in the bank:

- **VAGp** — single-channel, 48-byte header (BE/LE auto-detect), then
  raw PS-ADPCM blocks at the listed sample rate.
- **VPK** — multi-channel VAGp pack: header per channel, blocks
  concatenated then interleaved on decode.
- **XVAG** — Sony's container format. Has a chunk header with `fmat`
  giving the format. Two payloads:
  - `PS_ADPCM` (codec id 6) → decoded by the same 28-sample loop.
  - `MPEG` (codec id 4) → currently surfaced as a clean error; not yet
    decoded (see Roadmap).

## Pitch table

`sceSdNote2Pitch(centerNote, centerFine, note, fine)` — SCEI's pitch
ratio lookup table, used to convert `SoundBank` "gain" entries (which
are actually note offsets) into final sample rates. Direct port of the
PS3 SDK function.

## WAV writer

`write_wav(samples, sample_rate, channel_count, output)` writes a PCM
16-bit WAV: RIFF header → fmt chunk → data chunk. Supports mono and
multi-channel.

## Bank-relative pointer fixup

The most subtle SCREAM detail: many "pointer" fields inside the bank are
**relative to the bank's IGHW base offset**, not file-absolute. Examples:

- `SCREAMSound.gains_ptr` (V1)
- `SCREAMBankHeader.streams_ptr`

If you forget the rebase, you'll seek into garbage and the decoder will
report invalid block headers. Our `dump_sound_bank_info` example dumps
every pointer with both raw and resolved-absolute values, which makes
diagnosis a one-glance affair.

## Frontend exposure

The `SoundPlayer` component (`src/components/SoundPlayer.tsx`) consumes the decoded
samples directly and feeds them into a Web Audio `AudioBuffer`. The
hierarchy's "Sounds" section lists every sound (from the bank's
`SoundNames` table) plus a row per orphan stream entry found via
brute-force header scan. Clicking a row plays it; the ⤓ button exports
to WAV via the native save dialog.

## SFX / Dialog / Music categorisation

The `CacheLibraryModal` Sound tab adds **sub-tabs** above the playlist
to filter by category. Classification lives in `api.ts::classifySound`
and runs entirely on the source filename — works for all 4 supported
games because Insomniac's naming is consistent across versions:

| Pattern in `SoundEntry.source` | Category |
|---|---|
| contains `dialogue` or `voice` | **Dialog** |
| contains `music` | **Music** |
| anything else (typically `*sound*`) | **SFX** |

Each sub-tab shows a count badge of how many entries fall into that
category. The active filter is reflected in the playlist + the
"Save N WAVs" batch button (so you can bulk-export e.g. all dialog
files in one operation without dragging through a flat list).

When the active sound entry falls out of the new filter (e.g. you had
a Dialog selected, then switched to Music), the selection auto-clears
to prevent a phantom "selected but invisible" state in the playlist.
