

use std::env;
use std::fs::File;
use std::io::{BufReader, Cursor, Read, Seek, SeekFrom};
use std::path::Path;
use std::process::ExitCode;

use lunalib::animation::SECT_ANIMATION;
use lunalib::{
    decode_animation, read_animation_control, read_animation_header, AssetKind, AssetLookup,
    IgFile,
};

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let mut level: Option<String> = None;
    let mut full = false;
    let mut decode_idx: Option<usize> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--full" => full = true,
            "--decode" => match args.next() {
                Some(v) => match v.parse::<usize>() {
                    Ok(n) => decode_idx = Some(n),
                    Err(_) => {
                        eprintln!("--decode: not a number: {v}");
                        return ExitCode::from(2);
                    }
                },
                None => {
                    eprintln!("--decode: missing animset index");
                    return ExitCode::from(2);
                }
            },
            "-h" | "--help" => {
                println!(
                    "usage: dump_animsets <level-folder> [--full] [--decode N]\n\
                     Lists every animset in <level>/animsets.dat with its\n\
                     parsed Animation header. --full also reads the\n\
                     control buffer (ref pose + track masks). --decode N\n\
                     fully decodes animset #N and dumps the first few\n\
                     frames of each animated bone — use this to spot-check\n\
                     that quaternions stay unit-length and translations\n\
                     don't explode."
                );
                return ExitCode::SUCCESS;
            }
            other => {
                if level.is_some() {
                    eprintln!("unexpected positional arg: {other}");
                    return ExitCode::from(2);
                }
                level = Some(other.to_string());
            }
        }
    }

    let Some(level) = level else {
        eprintln!("usage: dump_animsets <level-folder> [--full]");
        return ExitCode::from(2);
    };
    let level_path = Path::new(&level);
    if !level_path.is_dir() {
        eprintln!("not a directory: {level}");
        return ExitCode::from(1);
    }

    let lookup_path = level_path.join("assetlookup.dat");
    let animsets_path = level_path.join("animsets.dat");
    if !lookup_path.is_file() {
        eprintln!("missing assetlookup.dat at {}", lookup_path.display());
        return ExitCode::from(1);
    }
    if !animsets_path.is_file() {
        eprintln!("missing animsets.dat at {}", animsets_path.display());
        return ExitCode::from(1);
    }

    println!("Scanning animsets in {}", level_path.display());
    println!("{}", "─".repeat(80));

    let lookup_file = match File::open(&lookup_path) {
        Ok(f) => BufReader::new(f),
        Err(e) => {
            eprintln!("open assetlookup: {e}");
            return ExitCode::from(1);
        }
    };
    let mut lookup = match AssetLookup::open(lookup_file) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("parse assetlookup: {e}");
            return ExitCode::from(1);
        }
    };
    let ptrs = match lookup.pointers(AssetKind::Animset) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("read animset table: {e}");
            return ExitCode::from(1);
        }
    };
    println!("Animset table: {} entries", ptrs.len());
    if ptrs.is_empty() {
        println!("(level has no animsets)");
        return ExitCode::SUCCESS;
    }

    let mut animsets_file = match File::open(&animsets_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("open animsets.dat: {e}");
            return ExitCode::from(1);
        }
    };

    let mut totals = SummaryStats::default();
    for (i, ptr) in ptrs.iter().enumerate() {
        if let Err(e) = animsets_file.seek(SeekFrom::Start(u64::from(ptr.offset))) {
            eprintln!("[{i}] seek failed: {e}");
            continue;
        }
        let mut buf = vec![0u8; ptr.length as usize];
        if let Err(e) = animsets_file.read_exact(&mut buf) {
            eprintln!("[{i}] read failed: {e}");
            continue;
        }

        let mut ig = match IgFile::open(Cursor::new(buf)) {
            Ok(f) => f,
            Err(e) => {
                eprintln!(
                    "[{i}] tuid=0x{:016X} IGHW open failed: {e} (length={})",
                    ptr.tuid, ptr.length
                );
                totals.bad_chunks += 1;
                continue;
            }
        };

        let has_anim_section = ig.section(SECT_ANIMATION).is_some();
        if !has_anim_section {
            totals.no_clip_section += 1;
            continue;
        }

        match read_animation_header(&mut ig) {
            Ok(Some(h)) => {
                totals.with_clip += 1;
                totals.total_frames += h.num_frames as u64;
                totals.total_16_tracks += h.num_16bit_tracks as u64;
                totals.total_8_tracks += h.num_8bit_tracks as u64;
                println!(
                    "[{:>3}] tuid=0x{:016X}  '{}'\n        bones={}  frames={}  fps={:.1}  dur={:.2}s  flags=0x{:04X} ({})\n        tracks: 16-bit={}  8-bit={}  refValues={}  stride={}",
                    i,
                    ptr.tuid,
                    truncate(&h.name, 56),
                    h.num_bones,
                    h.num_frames,
                    h.frame_rate,
                    h.duration_seconds(),
                    h.flags,
                    flags_summary(&h),
                    h.num_16bit_tracks,
                    h.num_8bit_tracks,
                    h.num_reference_values,
                    h.frame_stride,
                );

                if full {
                    match read_animation_control(&mut ig, &h) {
                        Ok(ctrl) => {
                            println!(
                                "        control: refRot={}  refVal={}  refMasks={}  blend={}",
                                ctrl.ref_pose_rotations.len(),
                                ctrl.ref_pose_values.len(),
                                ctrl.ref_pose_masks.len(),
                                ctrl.blend_masks.len(),
                            );

                            let mut oob = 0;
                            for m in ctrl.track16_masks.iter().chain(ctrl.track8_masks.iter()) {
                                if m.bone_index >= h.num_bones {
                                    oob += 1;
                                }
                            }
                            if oob > 0 {
                                println!("        WARN: {} track(s) reference bone_index >= numBones", oob);
                                totals.oob_track_masks += oob;
                            }
                        }
                        Err(e) => {
                            println!("        ERR control: {e}");
                            totals.bad_control += 1;
                        }
                    }
                }

                if decode_idx == Some(i) {
                    match read_animation_control(&mut ig, &h) {
                        Ok(ctrl) => match decode_animation(&mut ig, &h, &ctrl, 1.0, 1.0) {
                            Ok(clip) => dump_decoded_clip(&clip),
                            Err(e) => println!("        ERR decode: {e}"),
                        },
                        Err(e) => println!("        ERR control (for decode): {e}"),
                    }
                }
            }
            Ok(None) => {
                totals.no_clip_section += 1;
            }
            Err(e) => {
                println!(
                    "[{:>3}] tuid=0x{:016X} animation parse error: {e}",
                    i, ptr.tuid
                );
                totals.bad_chunks += 1;
            }
        }
    }

    println!();
    println!("{}", "─".repeat(80));
    println!("Summary:");
    println!("  pointers              : {}", ptrs.len());
    println!("  with parsed clip      : {}", totals.with_clip);
    println!("  no 0xF000 section     : {}", totals.no_clip_section);
    println!("  IGHW open failures    : {}", totals.bad_chunks);
    if full {
        println!("  control parse errors  : {}", totals.bad_control);
        println!("  out-of-range tracks   : {}", totals.oob_track_masks);
    }
    println!("  total frames          : {}", totals.total_frames);
    println!("  total 16-bit tracks   : {}", totals.total_16_tracks);
    println!("  total 8-bit tracks    : {}", totals.total_8_tracks);

    ExitCode::SUCCESS
}

#[derive(Default)]
struct SummaryStats {
    with_clip: usize,
    no_clip_section: usize,
    bad_chunks: usize,
    bad_control: usize,
    oob_track_masks: u64,
    total_frames: u64,
    total_16_tracks: u64,
    total_8_tracks: u64,
}

fn flags_summary(h: &lunalib::AnimationHeader) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if h.is_looping() { parts.push("Looping"); }
    if h.is_additive() { parts.push("Additive"); }
    if h.is_packed_frames() { parts.push("PackedFrames"); }
    if parts.is_empty() { "—".to_string() } else { parts.join("|") }
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

fn dump_decoded_clip(clip: &lunalib::DecodedClip) {
    let mut animated_rot = 0usize;
    let mut animated_pos = 0usize;
    let mut animated_scl = 0usize;
    let mut bad_quat = 0usize;

    for b in &clip.bones {
        if b.rotation_animated { animated_rot += 1; }
        if b.translation_animated { animated_pos += 1; }
        if b.scale_animated { animated_scl += 1; }

        let kc = b.rotations.len() / 4;
        for k in 0..kc {
            let i = k * 4;
            let len_sq = b.rotations[i] * b.rotations[i]
                + b.rotations[i + 1] * b.rotations[i + 1]
                + b.rotations[i + 2] * b.rotations[i + 2]
                + b.rotations[i + 3] * b.rotations[i + 3];
            if (len_sq - 1.0).abs() > 0.01 {
                bad_quat += 1;
            }
        }
    }

    println!(
        "        decoded: bones={}  rot-anim={}  pos-anim={}  scl-anim={}  non-unit-quats={}",
        clip.bones.len(), animated_rot, animated_pos, animated_scl, bad_quat,
    );

    if let Some((bi, b)) = clip
        .bones
        .iter()
        .enumerate()
        .find(|(_, b)| b.rotation_animated)
    {
        let kc = (b.rotations.len() / 4).min(3);
        println!("        first animated bone {} — rotation keyframes:", bi);
        for k in 0..kc {
            let i = k * 4;
            println!(
                "          f{:<3} q=[{:>+8.5}, {:>+8.5}, {:>+8.5}, {:>+8.5}]",
                k, b.rotations[i], b.rotations[i + 1], b.rotations[i + 2], b.rotations[i + 3],
            );
        }
        if !b.translations.is_empty() {
            let kc = (b.translations.len() / 3).min(3);
            for k in 0..kc {
                let i = k * 3;
                println!(
                    "          f{:<3} t=[{:>+10.3}, {:>+10.3}, {:>+10.3}]",
                    k, b.translations[i], b.translations[i + 1], b.translations[i + 2],
                );
            }
        }
    }
}
