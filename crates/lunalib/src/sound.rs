//! Sound extraction from `resident_sound.dat` / `ps3sound.dat`.
//!
//! Ported from InsomniaToolset's
//! [extract_sound.cpp](../../../../InsomniaToolset/sound/extract_sound.cpp)
//! — the in-bank SCREAM path only for now (covers `resident_sound.dat`,
//! the most useful target). Streaming dialogue (XVAG/VAG/VPK) is a
//! follow-up; those need a sibling stream file plus mux/MPEG handling.
//!
//! ## Format overview (V1 = RFOM/R2; V2 has same struct layouts at
//! different section IDs):
//!
//! - IGHW container with sections:
//!   - `0x21000` `SoundBank` — 144 byte preamble + `SCREAMBankHeader`
//!     containing TYPE_BANK + TYPE_DATA sections
//!   - `0x21100` `SoundNames` — array of 64-byte fixed C-strings
//!   - `0x21200` `Sounds` — `{ num_sounds: u32, _: [u32; 3], Sound[] }`
//!     where `Sound = { type: u16, index: i16 }`
//!   - `0x21010` `SoundStreams` — streaming offset table (unused here)
//!
//! - For each `Sound` with `index >= 0` and `type == 0`:
//!   - `SCREAMSound` at `bank.sounds[index]`
//!   - For each `SCREAMGain` of type 1: read `SCREAMWaveform` at
//!     `bank.gainData + gain.streamOffset` then ADPCM-decode the bytes
//!     at `data_section + waveform.streamOffset`, emitting one WAV.
//!
//! ## ADPCM decoding
//!
//! 16-byte blocks → 28 i16 samples per block. The first byte's high
//! nibble selects a filter (0..4), low nibble is the shift amount.
//! Second byte's low 3 bits are flags; flag `0x7` resets state. The
//! remaining 14 bytes are 28 4-bit nibbles, sign-extended, scaled by
//! `(1 << 12) >> shift`, then run through a 2-tap filter.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use rayon::prelude::*;

use crate::error::Result;
use crate::igfile::IgFile;

/// Section IDs.
///
/// SCREAM has two version families:
/// - **V1** (RFOM, V1-era dialogue banks)
/// - **V2** (R2/R3 main `resident_sound.dat`, RCF — anything that
///   IT processes with `Version::V2`)
///
/// They share `SoundBank=0x21000` but the other three sections are
/// shifted by `+0x100` in V2 — and the IDs collide across versions
/// (V1's `SoundNames=0x21100` is V2's `SoundStreams=0x21100`!), so
/// reading the wrong family's offsets out of a bank gives garbage.
/// We detect which family is in use by checking whether `0x21300`
/// (V2-only `Sounds`) is present and use the right id set.
pub const SECT_SOUND_BANK: u32 = 0x21000;

pub const SECT_SOUND_STREAMS_V1: u32 = 0x21010;
pub const SECT_SOUND_NAMES_V1: u32 = 0x21100;
pub const SECT_SOUNDS_V1: u32 = 0x21200;

pub const SECT_SOUND_STREAMS_V2: u32 = 0x21100;
pub const SECT_SOUND_NAMES_V2: u32 = 0x21200;
pub const SECT_SOUNDS_V2: u32 = 0x21300;

// Backwards-compat aliases — kept while the rest of the crate
// migrates to id-set lookups. New callers should resolve via
// `detect_sound_ids` instead of pinning to V1.
pub const SECT_SOUND_STREAMS: u32 = SECT_SOUND_STREAMS_V1;
pub const SECT_SOUND_NAMES: u32 = SECT_SOUND_NAMES_V1;
pub const SECT_SOUNDS: u32 = SECT_SOUNDS_V1;

/// Resolved section IDs for the in-use SCREAM family. Carry this
/// around the parser instead of constants so V1 and V2 banks both
/// work without each call site duplicating the version detection.
#[derive(Debug, Clone, Copy)]
pub struct SoundIds {
    pub bank: u32,
    pub streams: u32,
    pub names: u32,
    pub sounds: u32,
}

/// Detect V1 vs V2 layout for a given IGHW. Looks for the V2-only
/// `Sounds=0x21300` section first; falling back to V1 only when
/// it's absent. The fallback is correct because V1 banks never have
/// a section at `0x21300`.
pub fn detect_sound_ids<R: Read + Seek>(ig: &mut IgFile<R>) -> SoundIds {
    if ig.section(SECT_SOUNDS_V2).is_some() {
        SoundIds {
            bank: SECT_SOUND_BANK,
            streams: SECT_SOUND_STREAMS_V2,
            names: SECT_SOUND_NAMES_V2,
            sounds: SECT_SOUNDS_V2,
        }
    } else {
        SoundIds {
            bank: SECT_SOUND_BANK,
            streams: SECT_SOUND_STREAMS_V1,
            names: SECT_SOUND_NAMES_V1,
            sounds: SECT_SOUNDS_V1,
        }
    }
}

/// One named sound. The `wav` field is a fully-self-contained little-
/// endian RIFF/WAVE file ready to play in `<audio>` or save to disk.
#[derive(Debug, Clone)]
pub struct ExtractedSound {
    /// Display name from `SoundNames` (stripped of NUL padding).
    pub name: String,
    /// Sound table index — stable identifier within this `.dat`.
    pub index: usize,
    /// Gain index within the SCREAMSound — multi-gain sounds emit
    /// several WAVs, suffixed with `_0`, `_1`, ... at the name level
    /// in IT. We carry that disambiguator here. Always 0 for stream
    /// sounds (which have no per-gain expansion).
    pub gain_index: u8,
    /// Sample rate in Hz. Bank sounds compute this from PS3 note pitch
    /// tables; stream sounds (XVAG/VAGp/VPK) read it directly from
    /// their container header.
    pub sample_rate: u32,
    /// Channel count baked into the WAV. 1 for mono (most bank sounds
    /// + VAGp); 2+ possible for VPK / multi-channel XVAG.
    pub channels: u16,
    /// Total samples per channel (post-decode).
    pub sample_count: u32,
    /// Encoded WAV bytes (PCM 16-bit, channel-interleaved).
    pub wav: Vec<u8>,
}

/// Lightweight summary — just name + index, for the Hierarchy list.
/// Full decoding happens on-demand in `extract_sound`.
#[derive(Debug, Clone)]
pub struct SoundSummary {
    pub name: String,
    pub index: usize,
    pub kind: SoundKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SoundKind {
    /// In-bank SCREAM waveform — fully extractable now.
    Bank,
    /// Streaming — references a sibling file (e.g. `streaming_sound.dat`).
    /// Returned in the summary so the UI can mark them as not-yet-supported,
    /// but we don't extract them yet.
    Stream,
}

/// PS3 ADPCM filter coefficients — same table the PSX/PS2/PS3 use.
const ADPCM_TABLE: [[i32; 2]; 5] = [[0, 0], [60, 0], [115, -52], [98, -55], [122, -60]];

/// Decode one 16-byte ADPCM block into 28 signed-16 samples. Pure port
/// of IT's `DecodeBlock` — kept self-contained so callers can use it
/// outside the sound bank flow if they need to (e.g. a future streaming
/// extractor).
pub fn decode_adpcm_block(
    data: &[u8; 16],
    samples_out: &mut [i16; 28],
    prev_sample: &mut i32,
    pp_sample: &mut i32,
) {
    let filter = (data[0] >> 4) as usize;
    let shift = (data[0] & 0xF) as u32;
    let flags = data[1] & 0x7;

    if flags == 0x7 {
        *samples_out = [0; 28];
        *prev_sample = 0;
        *pp_sample = 0;
        return;
    }

    let filter = filter.min(4);
    let coef0 = ADPCM_TABLE[filter][0];
    let coef1 = ADPCM_TABLE[filter][1];

    for i in 0..28 {
        // Each sample is 4 bits packed two-per-byte. Even indices use
        // the low nibble, odd indices the high nibble.
        let raw = data[2 + i / 2] as i32;
        let nibble = (raw << (28 - (i as i32 % 2) * 4)) >> 28; // sign-extend 4-bit
        // Match IT: scale by (1 << 12) then >> shift, then 2-tap filter.
        let scaled = (nibble * (1 << 12)).wrapping_shr(shift);
        let predicted = ((*prev_sample) * coef0 + (*pp_sample) * coef1) / 64;
        let sample = (scaled + predicted).clamp(i16::MIN as i32, i16::MAX as i32);
        *pp_sample = *prev_sample;
        *prev_sample = sample;
        samples_out[i] = sample as i16;
    }
}

/// Convert a sequence of ADPCM blocks to a Vec of i16 samples.
pub fn decode_adpcm_stream(blocks: &[u8]) -> Vec<i16> {
    let num_blocks = blocks.len() / 16;
    let mut out = Vec::with_capacity(num_blocks * 28);
    let mut prev = 0i32;
    let mut pp = 0i32;
    let mut buf = [0i16; 28];
    let mut block = [0u8; 16];
    for b in 0..num_blocks {
        block.copy_from_slice(&blocks[b * 16..b * 16 + 16]);
        decode_adpcm_block(&block, &mut buf, &mut prev, &mut pp);
        out.extend_from_slice(&buf);
    }
    out
}

/// Build a self-contained mono PCM 16-bit RIFF/WAVE file from the
/// given samples. Output bytes are little-endian; ready to feed to
/// `<audio>` via `URL.createObjectURL(blob)`.
pub fn write_wav_pcm16_mono(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    write_wav_pcm16(samples, sample_rate, 1)
}

/// Multi-channel PCM 16-bit WAV writer. Samples must already be
/// interleaved (LRLR for stereo, LRC… for surround). Same on-disk
/// layout as the mono writer just with `channels`/`block_align`
/// parameterized.
pub fn write_wav_pcm16(samples: &[i16], sample_rate: u32, channels: u16) -> Vec<u8> {
    let data_size = samples.len() * 2;
    let total = 36 + data_size;
    let block_align = channels * 2;
    let byte_rate = sample_rate * u32::from(block_align);
    let mut out = Vec::with_capacity(8 + total);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_size as u32).to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// PS1/PS3 note → pitch table. Used to derive the sample rate from
/// the waveform's `centerNote` / `centerFine` fields. Direct copy of
/// IT's `NotePitchTable`.
const NOTE_PITCH_TABLE: [u16; 134] = [
    0x8000, 0x879C, 0x8FAC, 0x9837, 0xA145, 0xAADC, 0xB504, 0xBFC8, 0xCB2F, 0xD744, 0xE411, 0xF1A1,
    0x8000, 0x800E, 0x801D, 0x802C, 0x803B, 0x804A, 0x8058, 0x8067, 0x8076, 0x8085, 0x8094, 0x80A3,
    0x80B1, 0x80C0, 0x80CF, 0x80DE, 0x80ED, 0x80FC, 0x810B, 0x811A, 0x8129, 0x8138, 0x8146, 0x8155,
    0x8164, 0x8173, 0x8182, 0x8191, 0x81A0, 0x81AF, 0x81BE, 0x81CD, 0x81DC, 0x81EB, 0x81FA, 0x8209,
    0x8218, 0x8227, 0x8236, 0x8245, 0x8254, 0x8263, 0x8272, 0x8282, 0x8291, 0x82A0, 0x82AF, 0x82BE,
    0x82CD, 0x82DC, 0x82EB, 0x82FA, 0x830A, 0x8319, 0x8328, 0x8337, 0x8346, 0x8355, 0x8364, 0x8374,
    0x8383, 0x8392, 0x83A1, 0x83B0, 0x83C0, 0x83CF, 0x83DE, 0x83ED, 0x83FD, 0x840C, 0x841B, 0x842A,
    0x843A, 0x8449, 0x8458, 0x8468, 0x8477, 0x8486, 0x8495, 0x84A5, 0x84B4, 0x84C3, 0x84D3, 0x84E2,
    0x84F1, 0x8501, 0x8510, 0x8520, 0x852F, 0x853E, 0x854E, 0x855D, 0x856D, 0x857C, 0x858B, 0x859B,
    0x85AA, 0x85BA, 0x85C9, 0x85D9, 0x85E8, 0x85F8, 0x8607, 0x8617, 0x8626, 0x8636, 0x8645, 0x8655,
    0x8664, 0x8674, 0x8683, 0x8693, 0x86A2, 0x86B2, 0x86C1, 0x86D1, 0x86E0, 0x86F0, 0x8700, 0x870F,
    0x871F, 0x872E,
];

fn note_to_pitch(center_note: i8, center_fine: i8, note: i16, fine: i16) -> u16 {
    // Direct port of `sceSdNote2Pitch` + `PS1Note2Pitch`. Returns the
    // 16-bit fixed-point pitch multiplier (0x8000 = 1.0×).
    let ps1_note;
    let cn = if center_note >= 0 {
        ps1_note = true;
        center_note as i32
    } else {
        ps1_note = false;
        -(center_note as i32)
    };
    let cf = center_fine as i32;
    let n = note as i32;
    let f = fine as i32;

    let _fine = f.wrapping_add(cf as u16 as i32);
    let _fine2 = if _fine < 0 { _fine + 127 } else { _fine } / 128;
    let _note = n + _fine2 - cn;
    let mut val3 = _note / 6;
    if _note < 0 {
        val3 -= 1;
    }
    let offset2 = _fine - _fine2 * 128;
    let mut val2 = if _note < 0 { -1 } else { 0 };
    if val3 < 0 {
        val3 -= 1;
    }
    val2 = (val3 / 2) - val2;
    let mut val = val2 - 2;
    let mut offset1 = _note - val2 * 12;
    if offset1 < 0 || (offset1 == 0 && offset2 < 0) {
        offset1 += 12;
        val = val2 - 3;
    }
    let mut offset2 = offset2;
    let mut offset1 = offset1;
    if offset2 < 0 {
        offset1 = (offset1 - 1) + _fine2;
        offset2 += (_fine2 + 1) * 128;
    }
    let i1 = offset1.clamp(0, 11) as usize;
    let i2 = (offset2 + 12).clamp(0, 133) as usize;
    let mut ret = (NOTE_PITCH_TABLE[i1] as i32 * NOTE_PITCH_TABLE[i2] as i32) / 0x10000;
    if val < 0 {
        ret = (ret + (1i32 << (-val - 1))) >> -val;
    }
    let pitch = ret as u16;
    if ps1_note {
        ((0x10F4A_i32 * pitch as i32) >> 16) as u16
    } else {
        pitch
    }
}

/// Compute the sample rate for a `SCREAMWaveform` using the same
/// formula as IT: `pitch * (1/0x1000) * 48000` where pitch comes from
/// `note_to_pitch(centerNote, centerFine, 0x3C, 0x00)`.
fn sample_rate_for(center_note: i8, center_fine: i8) -> u32 {
    let pitch = note_to_pitch(center_note, center_fine, 0x3C, 0x00);
    // 0.00024414062 ≈ 1.0 / 4096.0  →  pitch is fixed-point against 0x1000
    ((pitch as f32) * 0.000_244_140_62 * 48000.0) as u32
}

/// List sound entries in a `resident_sound.dat`-style IGHW. Reads only
/// the header sections — fast (typically < 100 KB read total) so it's
/// safe to call on level open.
pub fn list_sounds<R: Read + Seek>(ig: &mut IgFile<R>) -> Result<Vec<SoundSummary>> {
    let ids = detect_sound_ids(ig);
    let names_section = match ig.section(ids.names) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    let sounds_section = match ig.section(ids.sounds) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };

    // Sounds: 16-byte preamble (numSounds:u32 + 3×u32 padding) then
    // num_sounds × Sound{type:u16, index:i16}.
    ig.stream.seek_to(u64::from(sounds_section.offset))?;
    let num_sounds = ig.stream.read_u32()? as usize;
    let _ = ig.stream.read_u32()?;
    let _ = ig.stream.read_u32()?;
    let _ = ig.stream.read_u32()?;
    let mut entries: Vec<(u16, i16)> = Vec::with_capacity(num_sounds);
    for _ in 0..num_sounds {
        let kind = ig.stream.read_u16()?;
        let idx = ig.stream.read_i16()?;
        entries.push((kind, idx));
    }

    // Names: contiguous 64-byte slots.
    let mut out = Vec::with_capacity(num_sounds);
    for (i, (kind, idx)) in entries.iter().enumerate() {
        if *idx < 0 {
            continue;
        }
        ig.stream.seek_to(u64::from(names_section.offset) + (i as u64) * 64)?;
        let buf = ig.stream.read_bytes(64)?;
        let nul = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        let name = String::from_utf8_lossy(&buf[..nul]).into_owned();
        out.push(SoundSummary {
            name,
            index: i,
            kind: if *kind == 0 {
                SoundKind::Bank
            } else {
                SoundKind::Stream
            },
        });
    }
    Ok(out)
}

/// Extract every in-bank sound to PCM-16 mono WAV. Streaming sounds
/// (type != 0) are skipped — those need a sibling stream file we
/// don't currently parse.
pub fn extract_bank_sounds<R: Read + Seek>(
    ig: &mut IgFile<R>,
) -> Result<Vec<ExtractedSound>> {
    let ids = detect_sound_ids(ig);
    let bank_section = match ig.section(ids.bank) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    let names_section = match ig.section(ids.names) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    let sounds_section = match ig.section(ids.sounds) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };

    // Read SoundBank.
    //   section[0..144]    : `unk[144]` preamble (mostly zeros)
    //   section[144..]     : `SCREAMBankHeader { u32 version, u32 numSections,
    //                         SCREAMSection sections[]; }`
    //
    // Each `SCREAMSection.data` is a `PointerX86<char>` whose on-disk u32
    // is relative to **the SCREAMBankHeader start**. So the actual
    // `SCREAMBank` and `DATA` blob positions are:
    //   bank_data_pos = header_base + sections[0].data
    //   data_data_pos = header_base + sections[1].data
    //
    // Verified against R2 axbridge_coop/resident_sound.dat: section at
    // 0xc980 → header_base = 0xca10 → sections[0].data = 0x20 → SCREAMBank
    // at 0xca30 (id "SBlk", version=3, numSounds at +0x16 = 0x315).
    let bank_base = u64::from(bank_section.offset);
    let header_base = bank_base + 144;
    ig.stream.seek_to(header_base + 4)?;
    let num_sections = ig.stream.read_u32()? as usize;
    if num_sections < 2 {
        return Ok(Vec::new());
    }
    let bank_data_ptr_rel = u64::from(ig.stream.read_u32()?);
    let _bank_size = ig.stream.read_u32()?;
    let data_data_ptr_rel = u64::from(ig.stream.read_u32()?);
    let _data_size = ig.stream.read_u32()?;
    let bank_data_pos = header_base + bank_data_ptr_rel;
    let data_data_pos = header_base + data_data_ptr_rel;

    // SCREAMBank starts at bank_data_pos. Layout per IT's struct
    // (NO padding between fields — `sounds_ptr` is at offset 0x1C
    // immediately after `unk0` at 0x1A):
    //   0x00 u32 id ("SBlk")
    //   0x04 u32 version
    //   0x08 u32 flags
    //   0x0C u16 null0[5]   (10 bytes)
    //   0x16 u16 numSounds
    //   0x18 u16 numGains
    //   0x1A u16 unk0
    //   0x1C u32 sounds_ptr     ← PointerX86<SCREAMSound>, relative to bank_data_pos
    //   0x20 u32 gains_ptr      ← relative to bank_data_pos
    //   0x24 u32 unk2
    //   0x28 u32 dataSize0
    //   0x2C u32 dataSize1
    //   0x30 u32 null2
    //   0x34 u32 gainData_ptr   ← relative to bank_data_pos
    ig.stream.seek_to(bank_data_pos + 0x16)?;
    let num_bank_sounds = ig.stream.read_u16()? as usize;
    let _num_bank_gains = ig.stream.read_u16()? as usize;
    let _unk0 = ig.stream.read_u16()?;
    let bank_sounds_ptr_rel = u64::from(ig.stream.read_u32()?);
    let _bank_gains_ptr_rel = u64::from(ig.stream.read_u32()?);
    let _ = ig.stream.read_u32()?; // unk2
    let _ = ig.stream.read_u32()?; // dataSize0
    let _ = ig.stream.read_u32()?; // dataSize1
    let _ = ig.stream.read_u32()?; // null2
    let bank_gain_data_ptr_rel = u64::from(ig.stream.read_u32()?);
    let bank_sounds_pos = bank_data_pos + bank_sounds_ptr_rel;
    let bank_gain_data_pos = bank_data_pos + bank_gain_data_ptr_rel;

    // Sounds table — preamble + entries.
    ig.stream.seek_to(u64::from(sounds_section.offset))?;
    let num_sounds = ig.stream.read_u32()? as usize;
    let _ = ig.stream.read_u32()?;
    let _ = ig.stream.read_u32()?;
    let _ = ig.stream.read_u32()?;
    let mut entries: Vec<(u16, i16)> = Vec::with_capacity(num_sounds);
    for _ in 0..num_sounds {
        let kind = ig.stream.read_u16()?;
        let idx = ig.stream.read_i16()?;
        entries.push((kind, idx));
    }

    let mut out = Vec::new();
    for (i, (kind, idx)) in entries.iter().enumerate() {
        if *idx < 0 || *kind != 0 {
            continue; // streaming or empty
        }
        let bank_idx = *idx as usize;
        if bank_idx >= num_bank_sounds {
            continue;
        }

        // SCREAMSound layout (12 bytes):
        //   0x00 u8 unk0, u8 unk1, u16 unk01
        //   0x04 u8 numGains, u8 unk
        //   0x06 u16 flags
        //   0x08 u32 gains_ptr
        let sound_off = bank_sounds_pos + (bank_idx as u64) * 12;
        ig.stream.seek_to(sound_off + 0x04)?;
        let num_gains = ig.stream.read_u8()? as usize;
        let _ = ig.stream.read_u8()?;
        let _flags = ig.stream.read_u16()?;
        let gains_ptr_rel = u64::from(ig.stream.read_u32()?);
        // PointerX86<SCREAMGain> inside SCREAMSound — relative to the
        // containing SCREAMBank buffer, NOT file-absolute. Without
        // this addition, every gain read lands in the IGHW header
        // area, returns garbage, and the resolved waveform offset
        // sends `seek_to` past EOF → "failed to fill whole buffer".
        let sound_gains_pos = bank_data_pos + gains_ptr_rel;

        // Pull this sound's name once.
        ig.stream.seek_to(u64::from(names_section.offset) + (i as u64) * 64)?;
        let name_buf = ig.stream.read_bytes(64)?;
        let nul = name_buf.iter().position(|b| *b == 0).unwrap_or(name_buf.len());
        let name = String::from_utf8_lossy(&name_buf[..nul]).into_owned();

        for g in 0..num_gains {
            // SCREAMGain (8 bytes):
            //   0x00 u24 streamOffset, u8 type
            //   0x04 u32 unk1
            ig.stream.seek_to(sound_gains_pos + (g as u64) * 8)?;
            let packed = ig.stream.read_u32()?;
            let stream_offset = packed & 0x00FFFFFF;
            let gain_type = (packed >> 24) & 0xFF;
            let _ = ig.stream.read_u32()?; // unk1
            if gain_type != 1 {
                continue;
            }

            // SCREAMWaveform (24 bytes) at bank_gain_data_pos + stream_offset.
            //   0x00 u8 unk0, u8 unk1
            //   0x02 i8 centerNote, i8 centerFine
            //   0x04 u32 unk2[2]                (8 bytes)
            //   0x0C u16 unk3
            //   0x0E u16 flags
            //   0x10 u32 streamOffset
            //   0x14 u32 streamSize
            let wform_off = bank_gain_data_pos + u64::from(stream_offset);
            ig.stream.seek_to(wform_off + 0x02)?;
            let center_note = ig.stream.read_u8()? as i8;
            let center_fine = ig.stream.read_u8()? as i8;
            ig.stream.seek_to(wform_off + 0x0E)?;
            let wf_flags = ig.stream.read_u16()?;
            let wf_stream_offset = u64::from(ig.stream.read_u32()?);
            let wf_stream_size = ig.stream.read_u32()? as usize;
            if wf_stream_size == 0 {
                continue;
            }

            // Read the raw ADPCM (or PCM) bytes from data section.
            ig.stream.seek_to(data_data_pos + wf_stream_offset)?;
            let raw = ig.stream.read_bytes(wf_stream_size)?;

            let sample_rate = sample_rate_for(center_note, center_fine);
            let use_pcm = (wf_flags & 0x80) != 0;

            let samples: Vec<i16> = if use_pcm {
                // Already PCM big-endian — byteswap into native i16.
                let mut s = Vec::with_capacity(raw.len() / 2);
                let mut k = 0;
                while k + 1 < raw.len() {
                    let v = i16::from_be_bytes([raw[k], raw[k + 1]]);
                    s.push(v);
                    k += 2;
                }
                s
            } else {
                decode_adpcm_stream(&raw)
            };
            let sample_count = samples.len() as u32;
            let wav = write_wav_pcm16_mono(&samples, sample_rate);

            out.push(ExtractedSound {
                name: if num_gains > 1 {
                    format!("{}_{}", name, g)
                } else {
                    name.clone()
                },
                index: i,
                gain_index: g as u8,
                sample_rate,
                channels: 1,
                sample_count,
                wav,
            });
        }
    }
    Ok(out)
}

/* ────────────────────────────────────────────────────────────────────────
 * Streaming sound extraction.
 *
 * Streamed sounds (where Sound.type != 0) are stored in a sibling
 * `streaming_*.dat` next to `resident_sound.dat`. The bank file's
 * `SoundStreams` section (0x21010) holds a u32 offset per index; you
 * seek the streaming file to that offset and find a self-describing
 * sound container with one of these magics:
 *
 *   "VAGp" (BE header) — single-channel PS-ADPCM, sample rate in header
 *   "pGAV" (LE header) — same, but header is little-endian (rare on PS3)
 *   "VPK "             — multi-channel PS-ADPCM, channel-interleaved
 *                         in fixed block sizes
 *   "XVAG"             — Sony's container; we handle the PS_ADPCM
 *                         format (interleave=1). MPEG payloads are
 *                         skipped with an error string for now.
 *
 * All ports based on InsomniaToolset's `extract_sound.cpp` — see the
 * `ConvertSound` overloads for VPK / VAGp / XVAGHeader. PS-ADPCM
 * decoding reuses our `decode_adpcm_block` from above.
 * ──────────────────────────────────────────────────────────────────────── */

/// Read the `SoundStreams` table — one u32 offset per stream-sound
/// index. Returns an empty Vec when the section is absent (level uses
/// only in-bank sounds). Length is derived from the section length so
/// we don't depend on a separate count field.
pub fn read_stream_offsets<R: Read + Seek>(ig: &mut IgFile<R>) -> Result<Vec<u32>> {
    let ids = detect_sound_ids(ig);
    let section = match ig.section(ids.streams) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    // Per IT's `SoundStreams` struct (and SoundStreamsV2 which inherits
    // from it):
    //   char unk0[128];                     // section bytes 0..128
    //   PointerX86<u32> streamOffsets;      // section bytes 128..132
    //   PointerX86<u32> unk1;               // section bytes 132..136
    //
    // The pointers are FILE-absolute offsets to the actual u32 arrays
    // (which typically live within the same section, just past the
    // pointer block). Count of stream offsets = (unk1 - streamOffsets) / 4.
    //
    // Verified against axbridge_coop/resident_sound.dat (V2):
    //   section @ 0x0236e000, length 0xB8.
    //   bytes 0x80..0x84: 0x0236e090  (streamOffsets ptr)
    //   bytes 0x84..0x88: 0x0236e0b0  (unk1 ptr)
    //   8 × u32 stream offsets at 0x0236e090.
    let total_len = section.length as u64;
    if total_len < 136 {
        return Ok(Vec::new());
    }
    let section_base = u64::from(section.offset);
    ig.stream.seek_to(section_base + 128)?;
    let stream_offsets_ptr = ig.stream.read_u32()? as u64;
    let unk1_ptr = ig.stream.read_u32()? as u64;
    if stream_offsets_ptr == 0 || unk1_ptr <= stream_offsets_ptr {
        return Ok(Vec::new());
    }
    let count = ((unk1_ptr - stream_offsets_ptr) / 4) as usize;
    if count == 0 {
        return Ok(Vec::new());
    }
    ig.stream.seek_to(stream_offsets_ptr)?;
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        out.push(ig.stream.read_u32()?);
    }
    Ok(out)
}

/// Multi-channel PS-ADPCM decoder state. One per channel; `prev` and
/// `pp` carry sample history across blocks.
#[derive(Default, Clone, Copy)]
struct AdpcmCh {
    prev: i32,
    pp: i32,
}

/// Decode a contiguous run of N 16-byte ADPCM blocks for one channel
/// directly into a Vec<i16> (28 samples per block). The `state` carries
/// the IIR history across calls so callers can decode in chunks.
fn decode_adpcm_run(blocks: &[u8], state: &mut AdpcmCh) -> Vec<i16> {
    let n = blocks.len() / 16;
    let mut out = Vec::with_capacity(n * 28);
    let mut buf = [0i16; 28];
    let mut block = [0u8; 16];
    for b in 0..n {
        block.copy_from_slice(&blocks[b * 16..b * 16 + 16]);
        decode_adpcm_block(&block, &mut buf, &mut state.prev, &mut state.pp);
        out.extend_from_slice(&buf);
    }
    out
}

/// Wire format for the four streaming containers we support. The
/// returned data is already PCM 16-bit interleaved across channels —
/// callers wrap it in a WAV with `write_wav_pcm16`.
#[derive(Debug)]
struct StreamPcm {
    sample_rate: u32,
    channels: u16,
    /// Channel-interleaved i16 samples. `samples.len() / channels` is
    /// the per-channel sample count.
    samples: Vec<i16>,
}

/// Decode a streaming sound starting at the current stream position.
/// Reads the magic, dispatches to the right container parser, and
/// returns the decoded PCM. Errors carry the file offset for
/// debugging — streaming files easily hit GB sizes so a stray offset
/// is hard to track down without it.
fn decode_one_stream<R: Read + Seek>(
    rd: &mut R,
    stream_offset: u64,
) -> std::io::Result<StreamPcm> {
    rd.seek(SeekFrom::Start(stream_offset))?;
    let mut magic = [0u8; 4];
    rd.read_exact(&mut magic)?;

    // Magic test against ASCII, file-byte order. Easiest to just
    // compare the byte sequence directly.
    match &magic {
        b"VAGp" => decode_vagp(rd, stream_offset, /*big_endian*/ true),
        b"pGAV" => decode_vagp(rd, stream_offset, /*big_endian*/ false),
        b"VPK " => decode_vpk(rd, stream_offset),
        b"XVAG" => decode_xvag(rd, stream_offset),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "unknown streaming sound magic {:02X?} at offset {}",
                magic, stream_offset
            ),
        )),
    }
}

/// VAGp header — 48 bytes total (4 magic + 44 below):
///   u32 null0[2]      (offset 4..12)
///   u32 dataSize      (offset 12..16)
///   u32 sampleRate    (offset 16..20)
///   u32 null1[7]      (offset 20..48)
/// Then `dataSize` bytes of PS-ADPCM follow at file offset 48.
/// Mono. The header is big-endian on PS3 ("VAGp" magic) and
/// little-endian on the rare "pGAV" form — controlled by `big_endian`.
///
/// Verified against `streaming_dialogue.us.dat` from R2 chicago:
/// magic=VAGp, dataSize=0xA980, sampleRate=0xBB80 (48000Hz),
/// audio at file offset 0x30.
fn decode_vagp<R: Read + Seek>(
    rd: &mut R,
    stream_offset: u64,
    big_endian: bool,
) -> std::io::Result<StreamPcm> {
    let mut header_rest = [0u8; 44];
    rd.read_exact(&mut header_rest)?;
    let read_u32 = |bytes: [u8; 4]| {
        if big_endian {
            u32::from_be_bytes(bytes)
        } else {
            u32::from_le_bytes(bytes)
        }
    };
    let data_size = read_u32([
        header_rest[8],
        header_rest[9],
        header_rest[10],
        header_rest[11],
    ]);
    let sample_rate = read_u32([
        header_rest[12],
        header_rest[13],
        header_rest[14],
        header_rest[15],
    ]);
    if data_size == 0 || sample_rate == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "VAGp at offset {stream_offset} has zero data_size or sample_rate"
            ),
        ));
    }

    // Audio body is at the current cursor position (after 4-byte magic
    // + 32-byte header_rest).
    let mut data = vec![0u8; data_size as usize];
    rd.read_exact(&mut data)?;
    let mut state = AdpcmCh::default();
    let samples = decode_adpcm_run(&data, &mut state);
    Ok(StreamPcm {
        sample_rate,
        channels: 1,
        samples,
    })
}

/// VPK container — multi-channel PS-ADPCM with per-channel block
/// interleaving. Header (32 bytes after magic):
///   u32 channelSize        (PS-ADPCM bytes per channel)
///   u32 dataOffset         (absolute file offset to first audio byte)
///   u32 channelBlockSize   (interleave block size — IT halves this)
///   u32 sampleRate
///   u32 numChannels
///   u32 unk1[2]
fn decode_vpk<R: Read + Seek>(
    rd: &mut R,
    stream_offset: u64,
) -> std::io::Result<StreamPcm> {
    let mut buf = [0u8; 32];
    rd.read_exact(&mut buf)?;
    // VPK is always little-endian (header values mirror the file layout
    // on PS3 — the bytes are already in target order).
    let channel_size = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as u64;
    let data_offset = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]) as u64;
    let channel_block_size_raw = u32::from_le_bytes([buf[8], buf[9], buf[10], buf[11]]) as u64;
    let sample_rate = u32::from_le_bytes([buf[12], buf[13], buf[14], buf[15]]);
    let num_channels = u32::from_le_bytes([buf[16], buf[17], buf[18], buf[19]]) as u16;
    if num_channels == 0 || sample_rate == 0 || channel_block_size_raw < 2 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("VPK at {stream_offset} has invalid header"),
        ));
    }
    // IT halves channelBlockSize: this is the size of one channel's
    // chunk inside an interleave group (vs. the multi-channel group
    // size carried in the header).
    let channel_block_size = channel_block_size_raw / 2;

    // The VPK absolute offset is from the START of the VPK stream, not
    // the file. Add `stream_offset` so we land on the right byte.
    rd.seek(SeekFrom::Start(stream_offset + data_offset))?;

    // Collect each channel's full PCM. We decode one interleave group
    // at a time, advance per channel, then interleave the resulting
    // samples sample-by-sample.
    let mut ch_states: Vec<AdpcmCh> = vec![AdpcmCh::default(); num_channels as usize];
    let mut ch_pcm: Vec<Vec<i16>> = (0..num_channels).map(|_| Vec::new()).collect();

    let num_groups = channel_size / channel_block_size;
    let rem = channel_size % channel_block_size;

    let decode_group = |group_size: u64,
                        rd: &mut R,
                        ch_states: &mut [AdpcmCh],
                        ch_pcm: &mut [Vec<i16>]|
     -> std::io::Result<()> {
        for c in 0..num_channels as usize {
            let mut block = vec![0u8; channel_block_size as usize];
            // Some files pad the last group — reading the per-channel
            // chunk then truncating to `group_size` matches IT's
            // behavior.
            rd.read_exact(&mut block)?;
            let usable = group_size.min(channel_block_size) as usize;
            let pcm = decode_adpcm_run(&block[..usable], &mut ch_states[c]);
            ch_pcm[c].extend_from_slice(&pcm);
        }
        Ok(())
    };

    for _ in 0..num_groups {
        decode_group(channel_block_size, rd, &mut ch_states, &mut ch_pcm)?;
    }
    if rem > 0 {
        decode_group(rem, rd, &mut ch_states, &mut ch_pcm)?;
    }

    // Interleave channels: LRLR…
    let per_channel = ch_pcm.iter().map(|v| v.len()).min().unwrap_or(0);
    let mut interleaved = Vec::with_capacity(per_channel * num_channels as usize);
    for s in 0..per_channel {
        for c in 0..num_channels as usize {
            interleaved.push(ch_pcm[c][s]);
        }
    }
    Ok(StreamPcm {
        sample_rate,
        channels: num_channels,
        samples: interleaved,
    })
}

/// XVAG container — Sony's PS3 audio container. Layout (all BE):
///   offset  0..4 : "XVAG"
///   offset  4..8 : size_to_body — file offset where audio bytes start
///   offset  8..12: version
///   offset 12..32: zeros / unknown
///   offset 32+   : sequence of 8-byte chunk headers `{u32 id, u32 size}`
///                  followed by `size` bytes of body. Stop when we hit
///                  `fmat`, then seek to `size_to_body` for audio.
///
/// `fmat` chunk body — 28 bytes (verified against
/// chicago/streaming_sound.dat's first XVAG; see commit notes):
///   u32 numChannels
///   u32 format       (PS_ADPCM=0x06, MPEG=0x08)
///   u32 numSamples
///   u32 unk1         (loop end?)
///   u32 interleave   (must be 1 for our decoder)
///   u32 sampleRate
///   u32 bufferSize   (PS-ADPCM body size in bytes)
///
/// Only PS_ADPCM with interleave==1 is decoded; MPEG / other formats
/// return an error.
fn decode_xvag<R: Read + Seek>(
    rd: &mut R,
    stream_offset: u64,
) -> std::io::Result<StreamPcm> {
    // 28-byte preamble after the magic — pulls out size_to_body, then
    // skips the 24 zero/version bytes that follow it. Chunks always
    // start at file offset 32 (relative to the XVAG magic).
    let mut hdr = [0u8; 28];
    rd.read_exact(&mut hdr)?;
    let size_to_body = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as u64;
    if size_to_body < 32 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "XVAG at {stream_offset} size_to_body={size_to_body} too small"
            ),
        ));
    }
    let chunks_end = stream_offset + size_to_body;

    let mut format = 0u32;
    let mut sample_rate = 0u32;
    let mut num_channels = 0u32;
    let mut interleave = 0u32;
    let mut buffer_size = 0u32;

    // Walk chunks until we either land on `fmat` or run past the
    // audio body offset. Other chunks (e.g. `cpan` for channel
    // panning metadata) get skipped by their declared size.
    loop {
        let chunk_start = rd.stream_position()?;
        if chunk_start + 8 > chunks_end {
            break;
        }
        let mut chunk = [0u8; 8];
        rd.read_exact(&mut chunk)?;
        let chunk_id = [chunk[0], chunk[1], chunk[2], chunk[3]];
        let chunk_size = u32::from_be_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]);
        if &chunk_id == b"fmat" {
            let mut fmat = [0u8; 28];
            rd.read_exact(&mut fmat)?;
            num_channels = u32::from_be_bytes([fmat[0], fmat[1], fmat[2], fmat[3]]);
            format = u32::from_be_bytes([fmat[4], fmat[5], fmat[6], fmat[7]]);
            let _num_samples =
                u32::from_be_bytes([fmat[8], fmat[9], fmat[10], fmat[11]]);
            let _unk1 =
                u32::from_be_bytes([fmat[12], fmat[13], fmat[14], fmat[15]]);
            interleave =
                u32::from_be_bytes([fmat[16], fmat[17], fmat[18], fmat[19]]);
            sample_rate =
                u32::from_be_bytes([fmat[20], fmat[21], fmat[22], fmat[23]]);
            buffer_size =
                u32::from_be_bytes([fmat[24], fmat[25], fmat[26], fmat[27]]);
            break;
        } else {
            rd.seek(SeekFrom::Start(chunk_start + 8 + u64::from(chunk_size)))?;
        }
    }

    if sample_rate == 0 || num_channels == 0 || buffer_size == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("XVAG at {stream_offset} missing fmat chunk"),
        ));
    }
    if format != 0x06 {
        // MPEG (0x08) and other formats: not yet supported. Return a
        // descriptive error so the frontend can surface a "not
        // playable" badge instead of crashing the extract loop.
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            format!(
                "XVAG at {stream_offset} uses format {format:#x} (only PS_ADPCM=0x06 supported)"
            ),
        ));
    }
    if interleave != 1 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            format!("XVAG at {stream_offset} interleave={interleave} unsupported"),
        ));
    }

    // Audio body starts at stream_offset + size_to_body (size is the
    // header-end offset relative to the XVAG start).
    rd.seek(SeekFrom::Start(stream_offset + size_to_body))?;

    let num_blocks_audio =
        (buffer_size as u64 / 16) / num_channels as u64;
    let mut ch_states: Vec<AdpcmCh> = vec![AdpcmCh::default(); num_channels as usize];
    let mut interleaved =
        Vec::with_capacity((num_blocks_audio * 28) as usize * num_channels as usize);

    let mut lane = [0u8; 16];
    let mut samples = [0i16; 28];
    for _ in 0..num_blocks_audio {
        // For each block: read one 16-byte lane per channel, decode,
        // then push samples sample-by-sample-channel-interleaved.
        let mut per_ch_samples: Vec<[i16; 28]> = Vec::with_capacity(num_channels as usize);
        for c in 0..num_channels as usize {
            rd.read_exact(&mut lane)?;
            let st = &mut ch_states[c];
            decode_adpcm_block(&lane, &mut samples, &mut st.prev, &mut st.pp);
            per_ch_samples.push(samples);
        }
        for s in 0..28 {
            for c in 0..num_channels as usize {
                interleaved.push(per_ch_samples[c][s]);
            }
        }
    }
    Ok(StreamPcm {
        sample_rate,
        channels: num_channels as u16,
        samples: interleaved,
    })
}

/// Extract every streaming-sound entry from a `resident_sound.dat`-
/// style IGHW + its sibling streaming file. Sounds whose container
/// magic isn't recognized (or whose XVAG format isn't PS_ADPCM) are
/// skipped with the error captured in `errors_out` so the caller can
/// surface a count or list.
///
/// `stream_path` should be the absolute path to the sibling
/// streaming file (e.g. `streaming_sound.dat` next to a V2
/// `resident_sound.dat`). Caller is responsible for picking the right
/// pairing — see `streaming_sibling_for` below.
pub fn extract_stream_sounds<R: Read + Seek>(
    ig: &mut IgFile<R>,
    stream_path: &Path,
    errors_out: &mut Vec<String>,
) -> Result<Vec<ExtractedSound>> {
    let ids = detect_sound_ids(ig);
    let names_section = match ig.section(ids.names) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    let sounds_section = match ig.section(ids.sounds) {
        Some(s) => s,
        None => return Ok(Vec::new()),
    };
    let stream_offsets = read_stream_offsets(ig)?;
    if stream_offsets.is_empty() {
        return Ok(Vec::new());
    }

    // Sound entries — same parse as list_sounds.
    ig.stream.seek_to(u64::from(sounds_section.offset))?;
    let num_sounds = ig.stream.read_u32()? as usize;
    let _ = ig.stream.read_u32()?;
    let _ = ig.stream.read_u32()?;
    let _ = ig.stream.read_u32()?;
    let mut entries: Vec<(u16, i16)> = Vec::with_capacity(num_sounds);
    for _ in 0..num_sounds {
        let kind = ig.stream.read_u16()?;
        let idx = ig.stream.read_i16()?;
        entries.push((kind, idx));
    }

    // Phase 1 — sequential metadata pass: build a Vec of work items
    // (index, name, offset). The streaming-file decode itself happens
    // in parallel below, but we need to collect names + offsets first
    // because they're read from the bank file (which we hold a single
    // reader on, not Send-safe to share).
    let mut work: Vec<(usize, String, u64)> = Vec::new();
    for (i, (kind, idx)) in entries.iter().enumerate() {
        if *idx < 0 || *kind == 0 {
            continue;
        }
        let stream_idx = *idx as usize;
        if stream_idx >= stream_offsets.len() {
            continue;
        }
        let offset = stream_offsets[stream_idx] as u64;

        ig.stream.seek_to(u64::from(names_section.offset) + (i as u64) * 64)?;
        let name_buf = ig.stream.read_bytes(64)?;
        let nul = name_buf
            .iter()
            .position(|b| *b == 0)
            .unwrap_or(name_buf.len());
        let name = String::from_utf8_lossy(&name_buf[..nul]).into_owned();
        work.push((i, name, offset));
    }

    // Phase 2 — parallel decode. Each rayon worker opens its own
    // `File` handle on the streaming file (handles are cheap; the OS
    // page cache keeps the actual disk I/O coherent across them).
    // Independent decode state means no shared mutex on the hot path
    // — the only synchronization is the final result collection.
    //
    // Result type per worker: `Result<ExtractedSound, String>` where
    // the Err carries the per-name decode error string. We partition
    // those into `out` + `errors_out` after.
    let stream_path_buf = stream_path.to_path_buf();
    let results: Vec<std::result::Result<ExtractedSound, String>> = work
        .par_iter()
        .map(|(i, name, offset)| {
            let file = File::open(&stream_path_buf).map_err(|e| {
                format!("{name}: open stream file: {e}")
            })?;
            let mut rd = BufReader::new(file);
            match decode_one_stream(&mut rd, *offset) {
                Ok(pcm) => {
                    let sample_count = if pcm.channels > 0 {
                        (pcm.samples.len() / pcm.channels as usize) as u32
                    } else {
                        0
                    };
                    let wav =
                        write_wav_pcm16(&pcm.samples, pcm.sample_rate, pcm.channels);
                    Ok(ExtractedSound {
                        name: name.clone(),
                        index: *i,
                        gain_index: 0,
                        sample_rate: pcm.sample_rate,
                        channels: pcm.channels,
                        sample_count,
                        wav,
                    })
                }
                Err(e) => Err(format!("{name}: {e}")),
            }
        })
        .collect();

    let mut out = Vec::with_capacity(results.len());
    for r in results {
        match r {
            Ok(s) => out.push(s),
            Err(msg) => errors_out.push(msg),
        }
    }
    // Stable order: rayon preserves input order in `collect` from
    // `par_iter`, so `out` is already sound-index-ascending. No sort
    // needed.
    Ok(out)
}

/// Brute-force-find audio container offsets in a streaming file
/// without needing the paired bank's offset table. Used for orphan
/// streaming files (e.g. R2 multiplayer maps that ship
/// `streaming_sound.dat` with no `resident_sound.dat` next to it —
/// the SFX bank lives elsewhere or only in a parent PSARC).
///
/// Scans the file for the four magic byte sequences our
/// `decode_one_stream` understands: `"VAGp"`, `"pGAV"`, `"XVAG"`,
/// `"VPK "`. False positives are rare (~0.5% per 4 GB on random
/// data), and any that slip through are filtered by the per-sound
/// decoder erroring out — caller gets clean PCM only.
pub fn scan_raw_audio_offsets(stream_path: &Path) -> Result<Vec<u64>> {
    let mut file = File::open(stream_path).map_err(crate::error::Error::Io)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data).map_err(crate::error::Error::Io)?;
    let mut offsets = Vec::new();
    if data.len() < 4 {
        return Ok(offsets);
    }
    let scan_end = data.len() - 3;
    let mut i = 0;
    while i < scan_end {
        let m = &data[i..i + 4];
        if m == b"VAGp" || m == b"pGAV" || m == b"XVAG" || m == b"VPK " {
            offsets.push(i as u64);
            // Skip past this header so we don't double-match the same
            // container if its body happens to contain the same magic.
            // 32 bytes is the minimum any header we support occupies
            // (XVAG's `fmat` chunk is bigger but always starts with
            // its own chunk-id, not one of these magics).
            i += 32;
        } else {
            i += 1;
        }
    }
    Ok(offsets)
}

/// Lightweight summary of a raw-scanned streaming file — one entry
/// per detected audio container, with synthetic names. Used to
/// populate the Hierarchy's Sounds section for orphan streams before
/// the user actually clicks any of them.
pub fn list_raw_streaming(stream_path: &Path) -> Result<Vec<SoundSummary>> {
    let offsets = scan_raw_audio_offsets(stream_path)?;
    Ok(offsets
        .iter()
        .enumerate()
        .map(|(i, off)| SoundSummary {
            name: format!("stream_{:05}_0x{:08X}", i, off),
            index: i,
            kind: SoundKind::Stream,
        })
        .collect())
}

/// Decode every raw-scanned audio container in an orphan streaming
/// file. Parallelized via rayon — each detected offset is decoded
/// independently. Per-offset failures (false-positive magic match,
/// MPEG XVAG, etc.) are captured in `errors_out` and don't abort
/// the batch.
pub fn extract_raw_streaming(
    stream_path: &Path,
    errors_out: &mut Vec<String>,
) -> Result<Vec<ExtractedSound>> {
    let offsets = scan_raw_audio_offsets(stream_path)?;
    if offsets.is_empty() {
        return Ok(Vec::new());
    }
    let stream_path_buf = stream_path.to_path_buf();
    let results: Vec<std::result::Result<ExtractedSound, String>> = offsets
        .par_iter()
        .enumerate()
        .map(|(i, offset)| {
            let label = format!("stream_{:05}_0x{:08X}", i, offset);
            let file = File::open(&stream_path_buf)
                .map_err(|e| format!("{label}: open: {e}"))?;
            let mut rd = BufReader::new(file);
            match decode_one_stream(&mut rd, *offset) {
                Ok(pcm) => {
                    let sample_count = if pcm.channels > 0 {
                        (pcm.samples.len() / pcm.channels as usize) as u32
                    } else {
                        0
                    };
                    let wav =
                        write_wav_pcm16(&pcm.samples, pcm.sample_rate, pcm.channels);
                    Ok(ExtractedSound {
                        name: label,
                        index: i,
                        gain_index: 0,
                        sample_rate: pcm.sample_rate,
                        channels: pcm.channels,
                        sample_count,
                        wav,
                    })
                }
                Err(e) => Err(format!("{label}: {e}")),
            }
        })
        .collect();

    let mut out = Vec::with_capacity(results.len());
    for r in results {
        match r {
            Ok(s) => out.push(s),
            Err(msg) => errors_out.push(msg),
        }
    }
    Ok(out)
}

/// Inverse of `streaming_sibling_for` — given a streaming filename,
/// returns the bank filename it would normally pair with. Used by
/// `list_level_sounds` to detect "orphan" streaming files (those
/// whose expected bank isn't in the same folder) and route them
/// through the raw scanner instead.
pub fn bank_pair_for(stream_filename: &str) -> Option<String> {
    let lower = stream_filename.to_lowercase();
    if lower == "streaming_sound.dat" {
        return Some("resident_sound.dat".to_string());
    }
    if let Some(rest) = lower.strip_prefix("streaming_dialogue") {
        return Some(format!("resident_dialogue{rest}"));
    }
    if lower == "ps3soundstream.dat" {
        return Some("ps3sound.dat".to_string());
    }
    if let Some(rest) = lower.strip_prefix("ps3dialoguestream") {
        return Some(format!("ps3dialogue{rest}"));
    }
    None
}

/// Pick the streaming-file partner for a given resident bank file
/// name. Mirrors IT's pairing in `AppProcessFile`:
///
///   resident_sound.dat        → streaming_sound.dat
///   resident_dialogue<X>.dat  → streaming_dialogue<X>.dat
///   ps3sound.dat              → ps3soundstream.dat
///   ps3dialogue<X>.dat        → ps3dialoguestream<X>.dat
///
/// Returns `None` for filenames that don't match any known scheme.
pub fn streaming_sibling_for(filename: &str) -> Option<String> {
    if filename == "resident_sound.dat" {
        return Some("streaming_sound.dat".to_string());
    }
    if let Some(rest) = filename.strip_prefix("resident_dialogue") {
        // `rest` includes e.g. ".dat" or "_lang.dat" — keep it.
        return Some(format!("streaming_dialogue{rest}"));
    }
    if filename == "ps3sound.dat" {
        return Some("ps3soundstream.dat".to_string());
    }
    if let Some(rest) = filename.strip_prefix("ps3dialogue") {
        return Some(format!("ps3dialoguestream{rest}"));
    }
    None
}

/* ────────────────────────────────────────────────────────────────────────
 * Self-diagnostic dumper.
 *
 * Why this exists: SCREAM banks have several layers of pointer
 * indirection (IGHW section → SCREAMBankHeader → SCREAMBank →
 * sounds/gains/gainData arrays), each with its own resolution rule
 * (header-relative vs bank-relative). Getting one wrong sends the
 * parser into garbage memory and you get cryptic
 * "failed to fill whole buffer" errors with no clue where it broke.
 *
 * `dump_sound_bank_info` walks every level of the structure and
 * prints what it sees, with both the on-disk u32 and the resolved
 * file-absolute address. Lets us verify a level's layout in seconds
 * — paste the output and any bad pointer is immediately visible
 * (e.g. an absurdly small sounds_ptr means the resolution base is
 * off; an out-of-bounds resolved address means the relative-base
 * choice is wrong).
 *
 * Output is plain UTF-8 — wrap in `#[tauri::command]` to surface in
 * the Console panel from the UI, or `println!` it from a CLI tool.
 * ──────────────────────────────────────────────────────────────────────── */

/// Render a u32 ID as a four-character ASCII tag (BE byte order),
/// substituting `.` for non-printable bytes. Used to make SCREAM
/// magic IDs readable in the dump output.
fn fourcc_be(id: u32) -> String {
    let bytes = id.to_be_bytes();
    bytes
        .iter()
        .map(|b| {
            if (0x20..=0x7e).contains(b) {
                *b as char
            } else {
                '.'
            }
        })
        .collect()
}

/// Print every layer of a SCREAM bank: detected version, IGHW
/// sections, SCREAMBankHeader pointers (with resolved addresses),
/// SCREAMBank fields + resolved subpointer targets, first few Sounds
/// entries, first few stream offsets. Cheap — only reads metadata,
/// never decodes audio.
///
/// Designed to be the first thing you call when an extract command
/// returns "io: failed to fill whole buffer" or empty results: the
/// dump tells you exactly which pointer is bad without manual
/// hexdumping.
pub fn dump_sound_bank_info<R: Read + Seek>(ig: &mut IgFile<R>) -> Result<String> {
    use std::fmt::Write as _;
    let mut out = String::new();
    let ids = detect_sound_ids(ig);
    let version_tag = if ids.sounds == SECT_SOUNDS_V2 {
        "V2"
    } else {
        "V1"
    };
    let _ = writeln!(out, "SCREAM bank diagnostic — {} layout", version_tag);
    let _ = writeln!(
        out,
        "  IDs: bank={:#x}, sounds={:#x}, names={:#x}, streams={:#x}",
        ids.bank, ids.sounds, ids.names, ids.streams
    );

    // Section presence + size.
    for (label, id) in [
        ("SoundBank", ids.bank),
        ("Sounds", ids.sounds),
        ("SoundNames", ids.names),
        ("SoundStreams", ids.streams),
    ] {
        match ig.section(id) {
            Some(s) => {
                let _ = writeln!(
                    out,
                    "  Section {:13} ({:#06x}): offset={:#010x} length={:#010x}",
                    label, id, s.offset, s.length
                );
            }
            None => {
                let _ = writeln!(
                    out,
                    "  Section {:13} ({:#06x}): MISSING",
                    label, id
                );
            }
        }
    }

    // SCREAMBankHeader walk.
    if let Some(bs) = ig.section(ids.bank) {
        let header_base = u64::from(bs.offset) + 144;
        ig.stream.seek_to(header_base)?;
        let bank_header_version = ig.stream.read_u32()?;
        let num_sections = ig.stream.read_u32()?;
        let _ = writeln!(
            out,
            "  SCREAMBankHeader @ {:#x}: version={} numSections={}",
            header_base, bank_header_version, num_sections
        );
        let cap_sections = num_sections.min(8) as usize;
        let mut section_data_pos: [u64; 2] = [0; 2];
        for i in 0..cap_sections {
            let ptr = ig.stream.read_u32()?;
            let size = ig.stream.read_u32()?;
            let resolved = header_base + u64::from(ptr);
            if i < section_data_pos.len() {
                section_data_pos[i] = resolved;
            }
            let _ = writeln!(
                out,
                "    sections[{}].data: ptr={:#010x} (→ {:#010x}), size={:#010x}",
                i, ptr, resolved, size
            );
        }

        // SCREAMBank walk (first SCREAMSection points here).
        if cap_sections >= 1 && section_data_pos[0] != 0 {
            let bank_pos = section_data_pos[0];
            ig.stream.seek_to(bank_pos)?;
            let id = ig.stream.read_u32()?;
            let bank_version = ig.stream.read_u32()?;
            let flags = ig.stream.read_u32()?;
            ig.stream.seek_to(bank_pos + 0x16)?;
            let num_sounds = ig.stream.read_u16()?;
            let num_gains = ig.stream.read_u16()?;
            let unk0 = ig.stream.read_u16()?;
            let sounds_ptr = ig.stream.read_u32()?;
            let gains_ptr = ig.stream.read_u32()?;
            let _unk2 = ig.stream.read_u32()?;
            let _ds0 = ig.stream.read_u32()?;
            let _ds1 = ig.stream.read_u32()?;
            let _null2 = ig.stream.read_u32()?;
            let gain_data_ptr = ig.stream.read_u32()?;
            let _ = writeln!(
                out,
                "  SCREAMBank @ {:#x}: id={:#010x} (\"{}\") version={} flags={:#x}",
                bank_pos,
                id,
                fourcc_be(id),
                bank_version,
                flags
            );
            let _ = writeln!(
                out,
                "    numSounds={} numGains={} unk0={:#x}",
                num_sounds, num_gains, unk0
            );
            let _ = writeln!(
                out,
                "    sounds_ptr   = {:#010x} (→ {:#010x})",
                sounds_ptr,
                bank_pos + u64::from(sounds_ptr)
            );
            let _ = writeln!(
                out,
                "    gains_ptr    = {:#010x} (→ {:#010x})",
                gains_ptr,
                bank_pos + u64::from(gains_ptr)
            );
            let _ = writeln!(
                out,
                "    gainData_ptr = {:#010x} (→ {:#010x})",
                gain_data_ptr,
                bank_pos + u64::from(gain_data_ptr)
            );
        }
    }

    // Sounds preview.
    if let Some(s) = ig.section(ids.sounds) {
        ig.stream.seek_to(u64::from(s.offset))?;
        let num = ig.stream.read_u32()?;
        let _ = ig.stream.read_u32()?;
        let _ = ig.stream.read_u32()?;
        let _ = ig.stream.read_u32()?;
        let _ = writeln!(out, "  Sounds: numSounds={}", num);
        let preview = num.min(5);
        for i in 0..preview {
            let kind = ig.stream.read_u16()?;
            let idx = ig.stream.read_i16()?;
            let kind_label = if kind == 0 { "bank" } else { "stream" };
            let _ = writeln!(
                out,
                "    [{}] kind={} ({}) index={}",
                i, kind, kind_label, idx
            );
        }
        if num > preview {
            let _ = writeln!(out, "    … ({} more)", num - preview);
        }
    }

    // SoundNames preview.
    if let Some(s) = ig.section(ids.names) {
        let _ = writeln!(
            out,
            "  SoundNames: capacity={} (slot=64 bytes)",
            s.length / 64
        );
        for i in 0..3.min(s.length / 64) {
            ig.stream.seek_to(u64::from(s.offset) + u64::from(i) * 64)?;
            let buf = ig.stream.read_bytes(64)?;
            let nul = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
            let name = String::from_utf8_lossy(&buf[..nul]);
            let _ = writeln!(out, "    [{}] \"{}\"", i, name);
        }
    }

    // Stream offsets preview.
    let stream_offsets = read_stream_offsets(ig).unwrap_or_default();
    let _ = writeln!(
        out,
        "  SoundStreams: {} offsets (resolved via 128-byte header + pointer table)",
        stream_offsets.len()
    );
    for (i, off) in stream_offsets.iter().take(5).enumerate() {
        let _ = writeln!(out, "    [{}] file_offset={:#010x}", i, off);
    }
    if stream_offsets.len() > 5 {
        let _ = writeln!(out, "    … ({} more)", stream_offsets.len() - 5);
    }

    Ok(out)
}
