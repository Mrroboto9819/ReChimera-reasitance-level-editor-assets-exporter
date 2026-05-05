//! End-to-end test: build a synthetic `assetlookup.dat` in memory, parse it
//! back through the public API, and check we recover the right pointers.

use std::io::Cursor;

use lunalib::{AssetKind, AssetLookup};

fn push_u16(buf: &mut Vec<u8>, v: u16) {
    buf.extend_from_slice(&v.to_be_bytes());
}
fn push_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_be_bytes());
}
fn push_u64(buf: &mut Vec<u8>, v: u64) {
    buf.extend_from_slice(&v.to_be_bytes());
}

#[test]
fn round_trip_moby_pointers() {
    // Layout:
    //   0x00..0x20  IGHW v1.1 header
    //   0x20..0x30  one section: id=0x1D600 (Moby), offset=0x30, length=0x20
    //   0x30..0x50  two AssetPointer entries (0x10 each)
    let mut buf = Vec::new();

    // Magic + version 1.1
    push_u32(&mut buf, 0x4947_4857); // 'IHGW' big-endian
    push_u16(&mut buf, 1);
    push_u16(&mut buf, 1);
    // Section count, header length, file length, unknown
    push_u32(&mut buf, 1);
    push_u32(&mut buf, 0x20);
    push_u32(&mut buf, 0x50);
    push_u32(&mut buf, 0);
    // 0x18..0x20 padding before section table
    buf.extend_from_slice(&[0u8; 8]);

    // One section header (16 bytes) at 0x20
    push_u32(&mut buf, AssetKind::Moby.section_id());
    push_u32(&mut buf, 0x30); // offset
    push_u32(&mut buf, 2);    // count (informational)
    push_u32(&mut buf, 0x20); // length = 2 * 0x10

    // AssetPointer #1
    push_u64(&mut buf, 0x1111_2222_3333_4444);
    push_u32(&mut buf, 0xAABB_CCDD);
    push_u32(&mut buf, 0x100);
    // AssetPointer #2
    push_u64(&mut buf, 0xDEAD_BEEF_CAFE_F00D);
    push_u32(&mut buf, 0x1000);
    push_u32(&mut buf, 0x200);

    let mut lookup = AssetLookup::open(Cursor::new(buf)).expect("parse");
    let mobys = lookup.pointers(AssetKind::Moby).expect("moby pointers");
    assert_eq!(mobys.len(), 2);
    assert_eq!(mobys[0].tuid, 0x1111_2222_3333_4444);
    assert_eq!(mobys[0].offset, 0xAABB_CCDD);
    assert_eq!(mobys[0].length, 0x100);
    assert_eq!(mobys[1].tuid, 0xDEAD_BEEF_CAFE_F00D);

    // Sections we didn't include should come back empty, not error.
    let ties = lookup.pointers(AssetKind::Tie).expect("tie pointers");
    assert!(ties.is_empty());
}
