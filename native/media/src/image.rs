//! Image dimensions from headers: PNG's IHDR, JPEG's SOF marker (found by hopping segment
//! lengths with seeks, so a camera JPEG with big EXIF blocks is still a handful of reads).

use std::io::{Read, Seek, SeekFrom};

use crate::probe::{io_error, read_up_to, Probe, ProbeError};

pub fn png<R: Read + Seek>(r: &mut R) -> Result<Probe, ProbeError> {
    let mut b = [0u8; 24];
    if read_up_to(r, &mut b)? < 24 || &b[12..16] != b"IHDR" {
        return Err(ProbeError::Unreadable("the PNG header is damaged".into()));
    }
    Ok(Probe {
        kind: "image",
        container: "png".into(),
        width: Some(u32::from_be_bytes([b[16], b[17], b[18], b[19]])),
        height: Some(u32::from_be_bytes([b[20], b[21], b[22], b[23]])),
        video_codec: Some("png".into()),
        via: "native",
        ..Default::default()
    })
}

/// EXIF orientation (1-8) to (clockwise degrees, mirrored).
fn orientation(o: u16) -> (u32, bool) {
    match o {
        2 => (0, true),
        3 => (180, false),
        4 => (180, true),
        5 => (270, true),
        6 => (90, false),
        7 => (90, true),
        8 => (270, false),
        _ => (0, false),
    }
}

/// The Orientation tag (0x0112) from an APP1 "Exif" segment's IFD0, if any.
fn exif_orientation(seg: &[u8]) -> Option<u16> {
    let tiff = seg.strip_prefix(b"Exif\0\0")?;
    let le = match tiff.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    let u16_at = |at: usize| tiff.get(at..at.checked_add(2)?).map(|b| if le { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) });
    let u32_at = |at: usize| tiff.get(at..at.checked_add(4)?).map(|b| if le { u32::from_le_bytes([b[0], b[1], b[2], b[3]]) } else { u32::from_be_bytes([b[0], b[1], b[2], b[3]]) });
    let ifd = u32_at(4)? as usize;
    let count = u16_at(ifd)? as usize;
    for i in 0..count.min(512) {
        let at = ifd.checked_add(2 + i * 12)?;
        if u16_at(at)? == 0x0112 {
            return u16_at(at + 8);
        }
    }
    None
}

pub fn jpeg<R: Read + Seek>(r: &mut R, len: u64) -> Result<Probe, ProbeError> {
    let mut pos: u64 = 2;
    let mut turn: Option<(u32, bool)> = None;
    for _ in 0..10_000 {
        if pos + 4 > len {
            break;
        }
        r.seek(SeekFrom::Start(pos)).map_err(io_error)?;
        let mut m = [0u8; 4];
        read_up_to(r, &mut m)?;
        if m[0] != 0xFF {
            break;
        }
        let marker = m[1];
        if marker == 0xFF {
            pos += 1; // fill byte
            continue;
        }
        if marker == 0xD8 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            pos += 2;
            continue;
        }
        let seg_len = u16::from_be_bytes([m[2], m[3]]) as u64;
        let is_sof = (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker);
        if marker == 0xE1 && turn.is_none() && seg_len >= 8 {
            let mut seg = vec![0u8; (seg_len as usize - 2).min(64 * 1024)];
            read_up_to(r, &mut seg)?;
            turn = exif_orientation(&seg).map(orientation).filter(|t| *t != (0, false));
        }
        if is_sof {
            r.seek(SeekFrom::Start(pos + 4)).map_err(io_error)?;
            let mut s = [0u8; 5];
            read_up_to(r, &mut s)?;
            return Ok(Probe {
                rotation: turn.map(|t| t.0),
                mirrored: turn.is_some_and(|t| t.1),
                kind: "image",
                container: "jpeg".into(),
                height: Some(u16::from_be_bytes([s[1], s[2]]) as u32),
                width: Some(u16::from_be_bytes([s[3], s[4]]) as u32),
                video_codec: Some("mjpeg".into()),
                via: "native",
                ..Default::default()
            });
        }
        if marker == 0xDA || marker == 0xD9 {
            break; // image data or end before any frame header
        }
        pos = pos.saturating_add(2 + seg_len);
    }
    Err(ProbeError::Unreadable("no frame header in this JPEG".into()))
}
