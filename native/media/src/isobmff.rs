//! A small ISO-BMFF (mp4/mov/m4a/heic) reader: just the boxes `probe` needs.
//!
//! Top-level boxes are skipped with seeks (a 3.6 GB `mdat` costs one seek), and only `ftyp`,
//! `moov`, a top-level `meta` (HEIC) and, for fragmented files, `moof` are read into memory.
//! Inside `moov` it reads `mvhd` (duration, creation time), `mvex` (fragmented files) and,
//! per `trak`, `tkhd` (id, matrix), `edts/elst` (what plays), `mdhd` (timescale), `hdlr`,
//! `stsd` (codec, coded size, `hvcC`/`avcC` profile, `esds`) and `stts` (frame durations).
//! Hand-rolled to control HEVC sample entries and DJI's extra tracks without a dependency.
//!
//! Every size in the file is untrusted: arithmetic is checked, box counts are capped, and
//! anything that doesn't add up is "unreadable" rather than a panic or a long walk.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};

use crate::probe::{gcd, io_error, qt_time, read_up_to, Probe, ProbeError};

/// Largest `moov`/`meta` we'll read; real ones are kilobytes to a few megabytes.
const MAX_HEADER_BOX: u64 = 256 * 1024 * 1024;
/// Largest single `moof` read when summing fragment durations.
const MAX_MOOF: u64 = 16 * 1024 * 1024;
/// Top-level boxes walked before giving up (a file of millions of tiny boxes is not media).
const MAX_TOP_LEVEL_BOXES: usize = 10_000;
/// Children listed per container.
const MAX_CHILDREN: usize = 100_000;

const TOP_LEVEL: [&[u8; 4]; 10] = [b"ftyp", b"moov", b"mdat", b"wide", b"free", b"skip", b"meta", b"pnot", b"uuid", b"styp"];

pub fn looks_like(fourcc: &[u8]) -> bool {
    TOP_LEVEL.iter().any(|t| &t[..] == fourcc)
}

fn bad(what: &str) -> ProbeError {
    ProbeError::Unreadable(format!("not a valid MP4/MOV file ({what})"))
}

/// Child boxes of a payload: (type, body). Stops quietly at a truncated or oversized box.
pub fn boxes(data: &[u8]) -> Vec<([u8; 4], &[u8])> {
    let mut out = Vec::new();
    let mut i = 0usize;
    while out.len() < MAX_CHILDREN {
        let remaining = data.len() - i;
        if remaining < 8 {
            break;
        }
        let size32 = u32::from_be_bytes(data[i..i + 4].try_into().unwrap()) as u64;
        let kind: [u8; 4] = data[i + 4..i + 8].try_into().unwrap();
        let (header, size) = match size32 {
            1 if remaining >= 16 => (16u64, u64::from_be_bytes(data[i + 8..i + 16].try_into().unwrap())),
            1 => break,
            0 => (8u64, remaining as u64),
            n => (8u64, n),
        };
        // Compare against what's left instead of adding: a hostile size can't overflow.
        if size < header || size > remaining as u64 {
            break;
        }
        let (h, s) = (header as usize, size as usize);
        out.push((kind, &data[i + h..i + s]));
        i += s;
    }
    out
}

fn child<'a>(data: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    boxes(data).into_iter().find(|(k, _)| k == kind).map(|(_, b)| b)
}

fn be16(d: &[u8], at: usize) -> Option<u16> {
    d.get(at..at.checked_add(2)?).map(|b| u16::from_be_bytes([b[0], b[1]]))
}
fn be32(d: &[u8], at: usize) -> Option<u32> {
    d.get(at..at.checked_add(4)?).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
}
fn be64(d: &[u8], at: usize) -> Option<u64> {
    d.get(at..at.checked_add(8)?).map(|b| u64::from_be_bytes(b.try_into().unwrap()))
}

#[derive(Debug, Default)]
struct Track {
    id: u32,
    handler: [u8; 4],
    timescale: u32,
    duration: u64,
    codec: Option<[u8; 4]>,
    profile: Option<String>,
    esds_oti: Option<u8>,
    width: u32,
    height: u32,
    rotation: u32,
    mirrored: bool,
    /// Sample count per sample duration, over the whole `stts` (not just contiguous runs).
    deltas: HashMap<u32, u64>,
    /// Total length of the edit list's non-empty segments, in movie time (None: no edit list).
    edited: Option<u64>,
}

/// Fragmented files: what the moov's `mvex` and the `moof`s say.
#[derive(Debug, Default)]
struct Fragments {
    /// `mehd` fragment_duration, in movie time.
    total: Option<u64>,
    /// `trex` default sample duration per track id.
    default_duration: HashMap<u32, u32>,
    /// Summed `trun` sample durations per track id, and sample counts per duration.
    durations: HashMap<u32, u64>,
    deltas: HashMap<u32, HashMap<u32, u64>>,
}

/// Reads the top-level boxes we need and skips the rest.
pub fn probe<R: Read + Seek>(r: &mut R, len: u64) -> Result<Probe, ProbeError> {
    let mut pos = 0u64;
    let mut brand: Option<[u8; 4]> = None;
    let mut moov: Option<Vec<u8>> = None;
    let mut meta: Option<Vec<u8>> = None;
    let mut moofs: Vec<Vec<u8>> = Vec::new();
    let mut walked = 0usize;
    loop {
        let Some(remaining) = len.checked_sub(pos) else { break };
        if remaining < 8 {
            break;
        }
        walked += 1;
        if walked > MAX_TOP_LEVEL_BOXES {
            return Err(bad("too many boxes"));
        }
        r.seek(SeekFrom::Start(pos)).map_err(io_error)?;
        let mut h = [0u8; 16];
        let got = read_up_to(r, &mut h)?;
        if got < 8 {
            break;
        }
        let size32 = u32::from_be_bytes(h[0..4].try_into().unwrap()) as u64;
        let kind: [u8; 4] = h[4..8].try_into().unwrap();
        let (header, size) = match size32 {
            1 if got >= 16 => (16u64, u64::from_be_bytes(h[8..16].try_into().unwrap())),
            1 => return Err(bad("truncated box header")),
            0 => (8u64, remaining),
            n => (8u64, n),
        };
        if size < header {
            return Err(bad("box smaller than its header"));
        }
        let body_len = (size - header).min(remaining - header.min(remaining));
        let fragmented = moov.as_deref().is_some_and(|m| child(m, b"mvex").is_some());
        let wanted = matches!(&kind, b"ftyp" | b"moov" | b"meta") || (&kind == b"moof" && fragmented);
        if wanted {
            let cap = if &kind == b"moof" { MAX_MOOF } else { MAX_HEADER_BOX };
            if body_len > cap {
                return Err(bad("header box is implausibly large"));
            }
            r.seek(SeekFrom::Start(pos + header)).map_err(io_error)?;
            let mut body = vec![0u8; body_len as usize];
            r.read_exact(&mut body).map_err(io_error)?;
            match &kind {
                b"ftyp" => brand = body.get(0..4).map(|b| b.try_into().unwrap()),
                b"moov" => moov = Some(body),
                b"moof" => moofs.push(body),
                _ => meta = Some(body),
            }
        }
        let Some(next) = pos.checked_add(size) else { break };
        pos = next;
        // Unfragmented files are done once the header is in; fragmented ones keep reading moofs.
        if brand.is_some() && moov.as_deref().is_some_and(|m| child(m, b"mvex").is_none()) {
            break;
        }
    }

    let container = match brand.as_ref().map(|b| &b[..]) {
        Some(b"qt  ") | None => "mov",
        Some(b"M4A ") | Some(b"M4B ") => "m4a",
        Some(b"heic") | Some(b"heix") | Some(b"mif1") | Some(b"msf1") | Some(b"heim") | Some(b"hevc") => "heic",
        _ => "mp4",
    };

    let Some(moov) = moov else {
        if container == "heic" {
            if let Some(meta) = meta {
                return heic(&meta);
            }
        }
        return Err(bad("no movie header (moov)"));
    };
    from_moov(&moov, &moofs, container)
}

fn heic(meta: &[u8]) -> Result<Probe, ProbeError> {
    // meta is a FullBox: 4 bytes of version/flags, then iprp > ipco > ispe (largest is the image).
    let body = meta.get(4..).ok_or_else(|| bad("empty meta"))?;
    let ipco = child(body, b"iprp").and_then(|p| child(p, b"ipco")).ok_or_else(|| bad("no item properties"))?;
    let props = boxes(ipco);
    let (w, h) = props
        .iter()
        .filter(|(k, _)| k == b"ispe")
        .filter_map(|(_, b)| Some((be32(b, 4)?, be32(b, 8)?)))
        .max_by_key(|(w, h)| *w as u64 * *h as u64)
        .ok_or_else(|| bad("no image size"))?;
    // irot: anticlockwise quarter turns; Uncut's rotation is clockwise degrees.
    let rotation = props.iter().find(|(k, _)| k == b"irot").and_then(|(_, b)| b.first()).map(|a| (360 - (*a as u32 & 3) * 90) % 360).filter(|r| *r != 0);
    Ok(Probe { kind: "image", container: "heic".into(), width: Some(w), height: Some(h), video_codec: Some("hevc".into()), rotation, via: "native", ..Default::default() })
}

fn fragments(moov: &[u8], moofs: &[Vec<u8>]) -> Fragments {
    let mut f = Fragments::default();
    if let Some(mvex) = child(moov, b"mvex") {
        if let Some(mehd) = child(mvex, b"mehd") {
            f.total = if mehd.first() == Some(&1) { be64(mehd, 4) } else { be32(mehd, 4).map(u64::from) };
        }
        for (_, trex) in boxes(mvex).into_iter().filter(|(k, _)| k == b"trex") {
            if let (Some(id), Some(d)) = (be32(trex, 4), be32(trex, 12)) {
                f.default_duration.insert(id, d);
            }
        }
    }
    for moof in moofs {
        for (_, traf) in boxes(moof).into_iter().filter(|(k, _)| k == b"traf") {
            let Some(tfhd) = child(traf, b"tfhd") else { continue };
            let flags = be32(tfhd, 0).unwrap_or(0) & 0x00FF_FFFF;
            let Some(id) = be32(tfhd, 4) else { continue };
            // tfhd optional fields, in order: base offset (8), description index (4), duration (4).
            let mut at = 8usize;
            if flags & 0x01 != 0 { at += 8; }
            if flags & 0x02 != 0 { at += 4; }
            let traf_default = if flags & 0x08 != 0 { be32(tfhd, at) } else { None };
            let default = traf_default.or_else(|| f.default_duration.get(&id).copied()).unwrap_or(0);
            for (_, trun) in boxes(traf).into_iter().filter(|(k, _)| k == b"trun") {
                let tflags = be32(trun, 0).unwrap_or(0) & 0x00FF_FFFF;
                let count = be32(trun, 4).unwrap_or(0) as usize;
                let mut at = 8usize;
                if tflags & 0x001 != 0 { at += 4; } // data offset
                if tflags & 0x004 != 0 { at += 4; } // first sample flags
                let per = [0x100, 0x200, 0x400, 0x800].iter().filter(|b| tflags & **b != 0).count() * 4;
                let deltas = f.deltas.entry(id).or_default();
                let total = f.durations.entry(id).or_default();
                for i in 0..count.min(1_000_000) {
                    let d = if tflags & 0x100 != 0 {
                        let Some(d) = be32(trun, at + i * per) else { break };
                        d
                    } else {
                        default
                    };
                    *total = total.saturating_add(d as u64);
                    *deltas.entry(d).or_default() += 1;
                }
            }
        }
    }
    f
}

fn from_moov(moov: &[u8], moofs: &[Vec<u8>], container: &str) -> Result<Probe, ProbeError> {
    let mut movie_scale = 0u32;
    let mut movie_duration = 0u64;
    let mut created = 0u64;
    if let Some(mvhd) = child(moov, b"mvhd") {
        if mvhd.first() == Some(&1) {
            created = be64(mvhd, 4).unwrap_or(0);
            movie_scale = be32(mvhd, 20).unwrap_or(0);
            movie_duration = be64(mvhd, 24).unwrap_or(0);
        } else {
            created = be32(mvhd, 4).unwrap_or(0) as u64;
            movie_scale = be32(mvhd, 12).unwrap_or(0);
            movie_duration = be32(mvhd, 16).unwrap_or(0) as u64;
        }
    }
    let mut tracks: Vec<Track> = boxes(moov).into_iter().filter(|(k, _)| k == b"trak").map(|(_, t)| track(t)).collect();

    // Fragmented: the moov's sample tables are empty; durations come from the fragments.
    let frags = fragments(moov, moofs);
    for t in &mut tracks {
        if t.duration == 0 || t.deltas.is_empty() {
            if let Some(d) = frags.durations.get(&t.id).filter(|d| **d > 0) {
                t.duration = *d;
            } else if let (Some(total), true) = (frags.total, movie_scale > 0 && t.timescale > 0) {
                t.duration = (total as u128 * t.timescale as u128 / movie_scale as u128) as u64;
            }
            if t.deltas.is_empty() {
                if let Some(deltas) = frags.deltas.get(&t.id) {
                    t.deltas = deltas.clone();
                } else if let Some(d) = frags.default_duration.get(&t.id).filter(|d| **d > 0) {
                    t.deltas.insert(*d, 1);
                }
            }
        }
    }
    if movie_duration == 0 {
        if let Some(total) = frags.total {
            movie_duration = total;
        }
    }

    // The main picture is the largest video track: DJI clips also carry a small MJPEG preview.
    let video = tracks.iter().filter(|t| &t.handler == b"vide" && t.codec.is_some()).max_by_key(|t| t.width as u64 * t.height as u64);
    let audio = tracks.iter().find(|t| &t.handler == b"soun");
    let kind = if video.is_some() { "video" } else if audio.is_some() { "audio" } else { return Err(ProbeError::Unsupported("no video or audio track".into())) };

    // The main track's own clock is the precise one (mvhd is often in milliseconds); this is
    // what ffprobe reports too. mvhd is the fallback.
    let main = video.or(audio);
    let duration_seconds = match main {
        Some(t) if t.timescale > 0 && t.duration > 0 => Some(track_seconds(t, movie_scale)),
        _ if movie_scale > 0 && movie_duration > 0 => Some(movie_duration as f64 / movie_scale as f64),
        _ => None,
    };

    let mut probe = Probe {
        kind,
        container: container.into(),
        duration_seconds,
        has_audio: audio.is_some(),
        audio_codec: audio.and_then(|a| a.codec.map(|c| audio_codec(&c, a.esds_oti))),
        creation_time: qt_time(created),
        via: "native",
        ..Default::default()
    };
    if let Some(v) = video {
        probe.width = Some(v.width);
        probe.height = Some(v.height);
        probe.video_codec = v.codec.map(|c| video_codec(&c));
        probe.video_profile = v.profile.clone();
        probe.rotation = Some(v.rotation);
        probe.mirrored = v.mirrored;
        // The frame rate is the most used frame duration (what ffprobe calls r_frame_rate),
        // not the average; it's display-only in Uncut.
        let delta = v.deltas.iter().max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))).map(|(d, _)| *d);
        if let (Some(delta), true) = (delta, v.timescale > 0) {
            let g = gcd(v.timescale as u64, delta as u64).max(1);
            let (num, den) = (v.timescale as u64 / g, delta as u64 / g);
            probe.fps = Some(format!("{num}/{den}"));
            probe.fps_value = Some(num as f64 / den as f64);
        }
    }
    Ok(probe)
}

/// A track's playable length: its media duration, capped at what the edit list plays (that
/// trims AAC priming off an audio track), which is how ffprobe reports it.
fn track_seconds(t: &Track, movie_scale: u32) -> f64 {
    let mut units = t.duration as f64;
    if let Some(seg) = t.edited {
        if seg > 0 && movie_scale > 0 {
            units = units.min(seg as f64 * t.timescale as f64 / movie_scale as f64);
        }
    }
    units / t.timescale as f64
}

fn track(trak: &[u8]) -> Track {
    let mut t = Track::default();
    if let Some(tkhd) = child(trak, b"tkhd") {
        let v1 = tkhd.first() == Some(&1);
        t.id = be32(tkhd, if v1 { 20 } else { 12 }).unwrap_or(0);
        let matrix_at = if v1 { 52 } else { 40 };
        let mut a = be32(tkhd, matrix_at).unwrap_or(0x10000) as i32 as i64;
        let mut b = be32(tkhd, matrix_at + 4).unwrap_or(0) as i32 as i64;
        let c = be32(tkhd, matrix_at + 12).unwrap_or(0) as i32 as i64;
        let d = be32(tkhd, matrix_at + 16).unwrap_or(0x10000) as i32 as i64;
        // A mirrored picture (negative determinant) is flipped back before reading the turn,
        // so a plain horizontal flip isn't mistaken for a 180° rotation.
        if a * d - b * c < 0 {
            t.mirrored = true;
            a = -a;
            b = -b;
        }
        // Clockwise degrees for display; ffprobe reports the same turn as a negative "rotation".
        let deg = (b as f64).atan2(a as f64).to_degrees().round() as i64;
        t.rotation = deg.rem_euclid(360) as u32;
    }
    if let Some(elst) = child(trak, b"edts").and_then(|e| child(e, b"elst")) {
        let v1 = elst.first() == Some(&1);
        let count = be32(elst, 4).unwrap_or(0) as usize;
        let size = if v1 { 20 } else { 12 };
        let mut total: u64 = 0;
        let mut any = false;
        for i in 0..count.min(4096) {
            let at = 8 + i * size;
            let (seg, media) = if v1 {
                (be64(elst, at), be64(elst, at + 8).map(|m| m as i64))
            } else {
                (be32(elst, at).map(u64::from), be32(elst, at + 4).map(|m| m as i32 as i64))
            };
            let (Some(seg), Some(media)) = (seg, media) else { break };
            // media_time -1 is an empty edit (a delay before the track starts): not playback.
            if media >= 0 {
                total = total.saturating_add(seg);
                any = true;
            }
        }
        if any {
            t.edited = Some(total);
        }
    }
    let Some(mdia) = child(trak, b"mdia") else { return t };
    if let Some(mdhd) = child(mdia, b"mdhd") {
        if mdhd.first() == Some(&1) {
            t.timescale = be32(mdhd, 20).unwrap_or(0);
            t.duration = be64(mdhd, 24).unwrap_or(0);
        } else {
            t.timescale = be32(mdhd, 12).unwrap_or(0);
            t.duration = be32(mdhd, 16).unwrap_or(0) as u64;
        }
    }
    if let Some(h) = child(mdia, b"hdlr").and_then(|h| h.get(8..12)) {
        t.handler = h.try_into().unwrap();
    }
    let Some(stbl) = child(mdia, b"minf").and_then(|m| child(m, b"stbl")) else { return t };
    if let Some(stsd) = child(stbl, b"stsd") {
        if let Some((codec, entry)) = stsd.get(8..).and_then(|e| boxes(e).into_iter().next()) {
            t.codec = Some(codec);
            if &t.handler == b"vide" {
                t.width = be16(entry, 24).unwrap_or(0) as u32;
                t.height = be16(entry, 26).unwrap_or(0) as u32;
                let children = entry.get(78..).unwrap_or(&[]);
                if let Some(hvcc) = child(children, b"hvcC") {
                    t.profile = hvcc.get(1).map(|b| hevc_profile(b & 0x1F));
                } else if let Some(avcc) = child(children, b"avcC") {
                    t.profile = avcc.get(1).map(|b| avc_profile(*b));
                }
            } else if &t.handler == b"soun" {
                let version = be16(entry, 8).unwrap_or(0);
                let start = 28 + match version { 1 => 16, 2 => 36, _ => 0 };
                let children = entry.get(start..).unwrap_or(&[]);
                t.esds_oti = child(children, b"esds").and_then(esds_object_type).or_else(|| {
                    // QuickTime nests esds inside a 'wave' box.
                    child(children, b"wave").and_then(|w| child(w, b"esds")).and_then(esds_object_type)
                });
            }
        }
    }
    if let Some(stts) = child(stbl, b"stts") {
        // Count samples per duration across every run, not just the longest contiguous one.
        let count = be32(stts, 4).unwrap_or(0) as usize;
        for i in 0..count.min(1_000_000) {
            let (Some(n), Some(d)) = (be32(stts, 8 + i * 8), be32(stts, 12 + i * 8)) else { break };
            if d > 0 && n > 0 {
                *t.deltas.entry(d).or_default() += n as u64;
            }
        }
    }
    t
}

/// objectTypeIndication from an esds box (ES_Descriptor > DecoderConfigDescriptor).
fn esds_object_type(esds: &[u8]) -> Option<u8> {
    let d = esds.get(4..)?; // FullBox version/flags
    let mut i = 0usize;
    for _ in 0..64 {
        if i >= d.len() {
            break;
        }
        let tag = d[i];
        i += 1;
        let mut len = 0usize;
        for _ in 0..4 {
            let b = *d.get(i)?;
            i += 1;
            len = (len << 7) | (b & 0x7F) as usize;
            if b & 0x80 == 0 {
                break;
            }
        }
        match tag {
            0x03 => {
                // ES_ID(2) + flags(1), then optional fields by flag.
                let flags = *d.get(i.checked_add(2)?)?;
                i = i.checked_add(3)?;
                if flags & 0x80 != 0 { i = i.checked_add(2)?; }
                if flags & 0x40 != 0 { i = i.checked_add(1 + *d.get(i)? as usize)?; }
                if flags & 0x20 != 0 { i = i.checked_add(2)?; }
            }
            0x04 => return d.get(i).copied(),
            _ => i = i.checked_add(len)?,
        }
    }
    None
}

fn video_codec(c: &[u8; 4]) -> String {
    match c {
        b"hvc1" | b"hev1" => "hevc",
        b"avc1" | b"avc3" => "h264",
        b"jpeg" | b"mjpa" | b"mjpb" | b"AVDJ" => "mjpeg",
        b"ap4h" | b"ap4x" | b"apch" | b"apcn" | b"apcs" | b"apco" => "prores",
        b"av01" => "av1",
        b"vp09" => "vp9",
        b"mp4v" => "mpeg4",
        _ => return String::from_utf8_lossy(c).trim().to_string(),
    }
    .into()
}

fn audio_codec(c: &[u8; 4], oti: Option<u8>) -> String {
    match (c, oti) {
        (b"mp4a", Some(0x69 | 0x6B)) => "mp3",
        (b"mp4a", _) => "aac",
        (b"ac-3", _) => "ac3",
        (b"ec-3", _) => "eac3",
        (b"Opus", _) => "opus",
        (b"fLaC", _) => "flac",
        (b"alac", _) => "alac",
        (b"lpcm" | b"sowt" | b"twos" | b"in24" | b"in32" | b"fl32" | b"fl64", _) => "pcm",
        _ => return String::from_utf8_lossy(c).trim().to_string(),
    }
    .into()
}

fn hevc_profile(idc: u8) -> String {
    match idc {
        1 => "Main".into(),
        2 => "Main 10".into(),
        3 => "Main Still Picture".into(),
        4 => "Rext".into(),
        n => format!("profile {n}"),
    }
}

fn avc_profile(idc: u8) -> String {
    match idc {
        66 => "Baseline".into(),
        77 => "Main".into(),
        88 => "Extended".into(),
        100 => "High".into(),
        110 => "High 10".into(),
        122 => "High 4:2:2".into(),
        244 => "High 4:4:4 Predictive".into(),
        n => format!("profile {n}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::{probe_reader, qt_time};
    use std::io::Cursor;

    fn bx(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(body);
        v
    }
    fn full(kind: &[u8; 4], version: u8, body: &[u8]) -> Vec<u8> {
        let mut b = vec![version, 0, 0, 0];
        b.extend_from_slice(body);
        bx(kind, &b)
    }
    fn cat(parts: &[Vec<u8>]) -> Vec<u8> {
        parts.concat()
    }
    fn mvhd(timescale: u32, duration: u32, created: u32) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend(created.to_be_bytes());
        b.extend(0u32.to_be_bytes());
        b.extend(timescale.to_be_bytes());
        b.extend(duration.to_be_bytes());
        b.extend([0u8; 80]);
        full(b"mvhd", 0, &b)
    }
    fn tkhd(a: i32, b_: i32, c: i32, d: i32, w: u16, h: u16) -> Vec<u8> {
        let mut b = vec![0u8; 20]; // times, track id, reserved, duration
        b.extend([0u8; 16]); // reserved, layer, group, volume, reserved
        for v in [a, b_, 0, c, d, 0, 0, 0, 0x4000_0000] {
            b.extend(v.to_be_bytes());
        }
        b.extend(((w as u32) << 16).to_be_bytes());
        b.extend(((h as u32) << 16).to_be_bytes());
        full(b"tkhd", 0, &b)
    }
    fn mdhd(timescale: u32, duration: u32) -> Vec<u8> {
        let mut b = vec![0u8; 8];
        b.extend(timescale.to_be_bytes());
        b.extend(duration.to_be_bytes());
        b.extend([0u8; 4]);
        full(b"mdhd", 0, &b)
    }
    fn hdlr(kind: &[u8; 4]) -> Vec<u8> {
        let mut b = vec![0u8; 4];
        b.extend(kind);
        b.extend([0u8; 13]);
        full(b"hdlr", 0, &b)
    }
    fn visual_entry(codec: &[u8; 4], w: u16, h: u16, extra: Vec<u8>) -> Vec<u8> {
        let mut b = vec![0u8; 24];
        b.extend(w.to_be_bytes());
        b.extend(h.to_be_bytes());
        b.extend([0u8; 50]);
        b.extend(extra);
        bx(codec, &b)
    }
    fn audio_entry(codec: &[u8; 4], oti: u8) -> Vec<u8> {
        let mut b = vec![0u8; 28];
        // esds: ES_Descriptor(tag 3) { ES_ID, flags=0, DecoderConfig(tag 4) { oti, ... } }
        let dcd = [0x04, 0x02, oti, 0x15];
        let mut es = vec![0x03, (3 + dcd.len()) as u8, 0, 1, 0];
        es.extend(dcd);
        b.extend(full(b"esds", 0, &es));
        bx(codec, &b)
    }
    fn stsd(entry: Vec<u8>) -> Vec<u8> {
        let mut b = 1u32.to_be_bytes().to_vec();
        b.extend(entry);
        full(b"stsd", 0, &b)
    }
    fn stts(entries: &[(u32, u32)]) -> Vec<u8> {
        let mut b = (entries.len() as u32).to_be_bytes().to_vec();
        for (n, d) in entries {
            b.extend(n.to_be_bytes());
            b.extend(d.to_be_bytes());
        }
        full(b"stts", 0, &b)
    }
    fn trak(tkhd: Vec<u8>, timescale: u32, duration: u32, handler: &[u8; 4], entry: Vec<u8>, stts_: Vec<u8>) -> Vec<u8> {
        let stbl = bx(b"stbl", &cat(&[stsd(entry), stts_]));
        let minf = bx(b"minf", &stbl);
        let mdia = bx(b"mdia", &cat(&[mdhd(timescale, duration), hdlr(handler), minf]));
        bx(b"trak", &cat(&[tkhd, mdia]))
    }
    fn hevc_track(w: u16, h: u16, rot: (i32, i32, i32, i32)) -> Vec<u8> {
        let hvcc = bx(b"hvcC", &[1, 0x02, 0, 0]); // profile_idc 2 = Main 10
        trak(tkhd(rot.0, rot.1, rot.2, rot.3, w, h), 60000, 600600, b"vide", visual_entry(b"hvc1", w, h, hvcc), stts(&[(600, 1001), (1, 500)]))
    }
    fn probe(bytes: &[u8]) -> Result<Probe, ProbeError> {
        probe_reader(&mut Cursor::new(bytes), bytes.len() as u64)
    }
    const ID: (i32, i32, i32, i32) = (0x10000, 0, 0, 0x10000);

    #[test]
    fn hevc_video_with_aac_audio_and_moov_after_mdat() {
        let audio = trak(tkhd(0x10000, 0, 0, 0x10000, 0, 0), 48000, 480480, b"soun", audio_entry(b"mp4a", 0x40), stts(&[(470, 1024)]));
        let moov = bx(b"moov", &cat(&[mvhd(1000, 10010, 3_874_476_148), hevc_track(3840, 2160, ID), audio]));
        let file = cat(&[bx(b"ftyp", b"isom\0\0\0\0isomiso2"), bx(b"mdat", &[0u8; 4096]), moov]);
        let p = probe(&file).unwrap();
        assert_eq!(p.kind, "video");
        assert_eq!(p.container, "mp4");
        assert_eq!((p.width, p.height), (Some(3840), Some(2160)));
        assert_eq!(p.fps.as_deref(), Some("60000/1001"));
        assert_eq!(p.duration_seconds, Some(10.01));
        assert_eq!(p.video_codec.as_deref(), Some("hevc"));
        assert_eq!(p.video_profile.as_deref(), Some("Main 10"));
        assert_eq!(p.audio_codec.as_deref(), Some("aac"));
        assert!(p.has_audio);
        assert_eq!(p.rotation, Some(0));
        assert_eq!(p.creation_time.as_deref(), Some("2026-10-10T11:22:28Z"));
    }

    #[test]
    fn rotation_from_the_track_matrix() {
        for (m, deg) in [((0, 0x10000, -0x10000, 0), 90), ((-0x10000, 0, 0, -0x10000), 180), ((0, -0x10000, 0x10000, 0), 270)] {
            let file = cat(&[bx(b"ftyp", b"qt  \0\0\0\0"), bx(b"moov", &cat(&[mvhd(600, 600, 0), hevc_track(1920, 1080, m)]))]);
            let p = probe(&file).unwrap();
            assert_eq!(p.rotation, Some(deg));
            assert_eq!(p.container, "mov");
            assert_eq!(p.creation_time, None);
        }
    }

    #[test]
    fn largesize_mdat_is_skipped_by_seeking() {
        let mut mdat = 1u32.to_be_bytes().to_vec();
        mdat.extend(b"mdat");
        mdat.extend((16u64 + 64).to_be_bytes());
        mdat.extend([7u8; 64]);
        let file = cat(&[bx(b"ftyp", b"mp42\0\0\0\0"), mdat, bx(b"moov", &cat(&[mvhd(600, 600, 0), hevc_track(1280, 720, ID)]))]);
        assert_eq!(probe(&file).unwrap().width, Some(1280));
    }

    #[test]
    fn the_largest_video_track_wins_over_a_small_mjpeg_preview() {
        let preview = trak(tkhd(0x10000, 0, 0, 0x10000, 960, 540), 90000, 900000, b"vide", visual_entry(b"jpeg", 960, 540, vec![]), stts(&[(10, 9000)]));
        let meta = trak(tkhd(0x10000, 0, 0, 0x10000, 0, 0), 60000, 600600, b"meta", bx(b"djmd", &[0u8; 8]), stts(&[(600, 1001)]));
        let file = cat(&[bx(b"ftyp", b"isom\0\0\0\0"), bx(b"moov", &cat(&[mvhd(1000, 10010, 0), preview, meta, hevc_track(3840, 2160, ID)]))]);
        let p = probe(&file).unwrap();
        assert_eq!((p.width, p.video_codec.as_deref(), p.fps.as_deref()), (Some(3840), Some("hevc"), Some("60000/1001")));
        assert!(!p.has_audio);
    }

    #[test]
    fn audio_only_m4a() {
        let audio = trak(tkhd(0x10000, 0, 0, 0x10000, 0, 0), 44100, 441000, b"soun", audio_entry(b"mp4a", 0x40), stts(&[(430, 1024)]));
        let p = probe(&cat(&[bx(b"ftyp", b"M4A \0\0\0\0"), bx(b"moov", &cat(&[mvhd(1000, 10000, 0), audio]))])).unwrap();
        assert_eq!((p.kind, p.container.as_str(), p.audio_codec.as_deref(), p.width), ("audio", "m4a", Some("aac"), None));
        assert_eq!(p.duration_seconds, Some(10.0));
    }

    #[test]
    fn broken_and_foreign_files_are_typed_errors() {
        assert_eq!(probe(b"hello, this is text and not a video").unwrap_err().code(), "unsupported");
        assert_eq!(probe(&bx(b"ftyp", b"isom\0\0\0\0")).unwrap_err().code(), "unreadable"); // no moov
        let mut liar = bx(b"ftyp", b"isom\0\0\0\0");
        liar.extend(4u32.to_be_bytes()); // a box smaller than its own header
        liar.extend(b"moov");
        assert_eq!(probe(&liar).unwrap_err().code(), "unreadable");
        let no_tracks = cat(&[bx(b"ftyp", b"isom\0\0\0\0"), bx(b"moov", &mvhd(600, 600, 0))]);
        assert_eq!(probe(&no_tracks).unwrap_err().code(), "unsupported");
    }

    #[test]
    fn png_and_jpeg_dimensions() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        png.extend(640u32.to_be_bytes());
        png.extend(480u32.to_be_bytes());
        png.extend([8, 2, 0, 0, 0]);
        let p = probe(&png).unwrap();
        assert_eq!((p.kind, p.container.as_str(), p.width, p.height), ("image", "png", Some(640), Some(480)));

        // SOI, an APP1 segment to hop over, then SOF0 with 1080 rows × 1920 columns.
        let mut jpg = vec![0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x08];
        jpg.extend(b"Exif\0\0");
        jpg.extend([0xFF, 0xC0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0x03]);
        jpg.extend([0u8; 9]);
        let p = probe(&jpg).unwrap();
        assert_eq!((p.container.as_str(), p.width, p.height), ("jpeg", Some(1920), Some(1080)));
    }

    #[test]
    fn quicktime_dates() {
        assert_eq!(qt_time(2_082_844_800 + 1).as_deref(), Some("1970-01-01T00:00:01Z"));
        assert_eq!(qt_time(2_082_844_800 + 951_782_400).as_deref(), Some("2000-02-29T00:00:00Z"));
        assert_eq!(qt_time(0), None);
    }

    #[test]
    fn the_fuzzer_found_overflow_is_a_typed_error_not_a_panic() {
        let hex = "000000106674797069736f6d00000000000000306d6f6f760000000866726565000000017472616bfffffffffffffff800000000000000000000000000000000";
        let bytes: Vec<u8> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect();
        assert!(probe(&bytes).is_err());
        // A huge 64-bit size at the top level as well.
        let mut top = bx(b"ftyp", b"isom\0\0\0\0");
        top.extend(1u32.to_be_bytes());
        top.extend(b"mdat");
        top.extend(u64::MAX.to_be_bytes());
        assert!(probe(&top).is_err());
    }

    #[test]
    fn a_file_of_endless_tiny_boxes_gives_up() {
        let mut file = bx(b"ftyp", b"isom\0\0\0\0");
        for _ in 0..20_000 {
            file.extend(bx(b"free", &[]));
        }
        let started = std::time::Instant::now();
        assert_eq!(probe(&file).unwrap_err().code(), "unreadable");
        assert!(started.elapsed().as_millis() < 500);
    }

    #[test]
    fn every_non_empty_edit_counts_and_empty_edits_dont() {
        // Two 1 s edits plus a 0.5 s empty edit (media_time -1): 2 s plays.
        let mut el = 3u32.to_be_bytes().to_vec();
        for (seg, media) in [(500u32, -1i32), (1000, 0), (1000, 30_000)] {
            el.extend(seg.to_be_bytes());
            el.extend(media.to_be_bytes());
            el.extend(0x0001_0000u32.to_be_bytes());
        }
        let edts = bx(b"edts", &full(b"elst", 0, &el));
        let hvcc = bx(b"hvcC", &[1, 0x01, 0, 0]);
        let stbl = bx(b"stbl", &cat(&[stsd(visual_entry(b"hvc1", 640, 360, hvcc)), stts(&[(180, 1000)])]));
        let mdia = bx(b"mdia", &cat(&[mdhd(30000, 180_000), hdlr(b"vide"), bx(b"minf", &stbl)]));
        let trak = bx(b"trak", &cat(&[tkhd(0x10000, 0, 0, 0x10000, 640, 360), edts, mdia]));
        let p = probe(&cat(&[bx(b"ftyp", b"isom\0\0\0\0"), bx(b"moov", &cat(&[mvhd(1000, 2500, 0), trak]))])).unwrap();
        assert_eq!(p.duration_seconds, Some(2.0));
        assert_eq!(p.video_profile.as_deref(), Some("Main"));
    }

    #[test]
    fn frame_rate_is_the_most_used_frame_duration_across_all_runs() {
        // Runs: 50×(1/60), 40×(1/30), 50×(1/60) → 1/60 is used by 100 frames: 60 fps.
        let hvcc = bx(b"hvcC", &[1, 0x02, 0, 0]);
        let t = trak(tkhd(0x10000, 0, 0, 0x10000, 320, 240), 6000, 1000 * 140, b"vide", visual_entry(b"hvc1", 320, 240, hvcc), stts(&[(50, 100), (40, 200), (50, 100)]));
        let p = probe(&cat(&[bx(b"ftyp", b"isom\0\0\0\0"), bx(b"moov", &cat(&[mvhd(1000, 1000, 0), t]))])).unwrap();
        assert_eq!(p.fps.as_deref(), Some("60/1"));
    }

    #[test]
    fn fragmented_files_get_duration_and_fps_from_their_fragments() {
        // moov with empty sample tables + mvex/trex (default duration 1000 at 30000 = 1/30 s),
        // then two moofs of 30 samples each: 2 s at 30 fps.
        let hvcc = bx(b"hvcC", &[1, 0x01, 0, 0]);
        let mut tk = tkhd(0x10000, 0, 0, 0x10000, 640, 360);
        tk[8 + 12..8 + 16].copy_from_slice(&1u32.to_be_bytes()); // track id 1
        let stbl = bx(b"stbl", &cat(&[stsd(visual_entry(b"hvc1", 640, 360, hvcc)), stts(&[])]));
        let mdia = bx(b"mdia", &cat(&[mdhd(30000, 0), hdlr(b"vide"), bx(b"minf", &stbl)]));
        let trak = bx(b"trak", &cat(&[tk, mdia]));
        let mut trex = 1u32.to_be_bytes().to_vec(); // track id
        trex.extend(1u32.to_be_bytes()); // description index
        trex.extend(1000u32.to_be_bytes()); // default duration
        trex.extend([0u8; 8]);
        let mvex = bx(b"mvex", &full(b"trex", 0, &trex));
        let moof = || {
            let tfhd = full(b"tfhd", 0, &1u32.to_be_bytes());
            let trun = full(b"trun", 0, &30u32.to_be_bytes());
            bx(b"moof", &bx(b"traf", &cat(&[tfhd, trun])))
        };
        let file = cat(&[bx(b"ftyp", b"iso6\0\0\0\0"), bx(b"moov", &cat(&[mvhd(1000, 0, 0), trak, mvex])), moof(), bx(b"mdat", &[0; 16]), moof(), bx(b"mdat", &[0; 16])]);
        let p = probe(&file).unwrap();
        assert_eq!(p.duration_seconds, Some(2.0));
        assert_eq!(p.fps.as_deref(), Some("30/1"));
    }

    #[test]
    fn a_mirrored_picture_is_not_reported_as_turned() {
        let file = cat(&[bx(b"ftyp", b"isom\0\0\0\0"), bx(b"moov", &cat(&[mvhd(600, 600, 0), hevc_track(640, 360, (-0x10000, 0, 0, 0x10000))]))]);
        let p = probe(&file).unwrap();
        assert_eq!((p.rotation, p.mirrored), (Some(0), true));
    }

    #[test]
    fn jpeg_exif_orientation_and_heic_irot_turn_images() {
        // EXIF IFD0 with Orientation = 6 (turned 90° clockwise), big-endian.
        let mut tiff = b"MM\0\x2a\0\0\0\x08".to_vec();
        tiff.extend(1u16.to_be_bytes());
        tiff.extend([0x01, 0x12, 0x00, 0x03, 0, 0, 0, 1, 0x00, 0x06, 0, 0]);
        tiff.extend(0u32.to_be_bytes());
        let mut app1 = b"Exif\0\0".to_vec();
        app1.extend(&tiff);
        let mut jpg = vec![0xFF, 0xD8, 0xFF, 0xE1];
        jpg.extend(((app1.len() + 2) as u16).to_be_bytes());
        jpg.extend(&app1);
        jpg.extend([0xFF, 0xC0, 0x00, 0x11, 0x08, 0x0B, 0xB8, 0x0F, 0xA0, 0x03]);
        jpg.extend([0u8; 9]);
        let p = probe(&jpg).unwrap();
        assert_eq!((p.width, p.height, p.rotation), (Some(4000), Some(3000), Some(90)));

        let mut ispe = vec![0u8; 4];
        ispe.extend(4032u32.to_be_bytes());
        ispe.extend(3024u32.to_be_bytes());
        let ipco = bx(b"ipco", &cat(&[bx(b"ispe", &ispe), bx(b"irot", &[1])]));
        let meta = full(b"meta", 0, &bx(b"iprp", &ipco));
        let p = probe(&cat(&[bx(b"ftyp", b"heic\0\0\0\0mif1heic"), meta])).unwrap();
        assert_eq!((p.kind, p.width, p.rotation), ("image", Some(4032), Some(270)));
    }

    /// Seeded mutations of valid files must never panic or take long, whatever the bytes say.
    /// (Debug builds also trap integer overflow, which is what a release build would wrap.)
    #[test]
    fn fuzz_mutated_files_never_panic() {
        let audio = trak(tkhd(0x10000, 0, 0, 0x10000, 0, 0), 48000, 48000, b"soun", audio_entry(b"mp4a", 0x40), stts(&[(47, 1024)]));
        let seeds = vec![
            cat(&[bx(b"ftyp", b"isom\0\0\0\0"), bx(b"mdat", &[0; 64]), bx(b"moov", &cat(&[mvhd(1000, 1000, 1), hevc_track(640, 360, ID), audio]))]),
            cat(&[bx(b"ftyp", b"qt  \0\0\0\0"), bx(b"moov", &cat(&[mvhd(600, 600, 0), hevc_track(320, 240, (0, 0x10000, -0x10000, 0))]))]),
        ];
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut rnd = move || {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x
        };
        let started = std::time::Instant::now();
        for i in 0..5000 {
            let mut f = seeds[i % seeds.len()].clone();
            for _ in 0..(1 + rnd() % 4) {
                let at = (rnd() as usize) % f.len();
                match rnd() % 5 {
                    0 => f[at] = rnd() as u8,
                    1 => {
                        let v = [0u32, 1, 7, 8, 16, 0xFFFF_FFFF, 0x7FFF_FFFF, 0x8000_0000][(rnd() % 8) as usize];
                        let end = (at + 4).min(f.len());
                        f[at..end].copy_from_slice(&v.to_be_bytes()[..end - at]);
                    }
                    2 => f.truncate(at.max(1)),
                    3 => {
                        let chunk = f[at..(at + 32).min(f.len())].to_vec();
                        f.splice(at..at, chunk);
                    }
                    _ => {
                        let end = (at + 8).min(f.len());
                        f[at..end].fill(0xFF);
                    }
                }
            }
            let one = std::time::Instant::now();
            let _ = probe(&f);
            assert!(one.elapsed().as_millis() < 200, "mutation {i} took {:?}", one.elapsed());
        }
        assert!(started.elapsed().as_secs() < 20);
    }
}
