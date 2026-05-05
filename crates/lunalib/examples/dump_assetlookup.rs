//! Smoke-test CLI: dump section / asset counts for an `assetlookup.dat`.
//!
//! Run it against a Resistance 2 or 3 level dump to validate the parser
//! before wiring the library into the Tauri shell.
//!
//! Example:
//!   cargo run -p lunalib --example dump_assetlookup -- path/to/assetlookup.dat

use std::env;
use std::fs::File;
use std::io::BufReader;
use std::process::ExitCode;

use lunalib::{AssetKind, AssetLookup};

fn main() -> ExitCode {
    let Some(path) = env::args().nth(1) else {
        eprintln!("usage: dump_assetlookup <path/to/assetlookup.dat>");
        return ExitCode::from(2);
    };

    let file = match File::open(&path) {
        Ok(f) => BufReader::new(f),
        Err(e) => {
            eprintln!("open {path}: {e}");
            return ExitCode::from(1);
        }
    };

    let mut lookup = match AssetLookup::open(file) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("parse {path}: {e}");
            return ExitCode::from(1);
        }
    };

    println!(
        "IGHW v{}.{} ({} sections)",
        lookup.file.version.major,
        lookup.file.version.minor,
        lookup.file.sections.len(),
    );

    println!();
    println!("Section table:");
    for s in &lookup.file.sections {
        println!(
            "  id 0x{:06X}  offset 0x{:08X}  count {:>6}  length 0x{:X}",
            s.id, s.offset, s.count, s.length,
        );
    }

    println!();
    println!("Known asset kinds:");
    for kind in AssetKind::all() {
        match lookup.pointers(*kind) {
            Ok(ptrs) if ptrs.is_empty() => {
                println!("  {:<8} (0x{:06X}): not present", kind.name(), kind.section_id());
            }
            Ok(ptrs) => {
                println!(
                    "  {:<8} (0x{:06X}): {} entries  (first tuid 0x{:016X})",
                    kind.name(),
                    kind.section_id(),
                    ptrs.len(),
                    ptrs[0].tuid,
                );
            }
            Err(e) => {
                eprintln!("  {:<8}: error: {}", kind.name(), e);
            }
        }
    }

    ExitCode::SUCCESS
}
