//! `probe`: what a media file is, read from its headers only. ISO-BMFF (mp4/mov/m4a) is
//! walked box by box with seeks, so a multi-gigabyte clip costs a few reads; PNG, JPEG and
//! HEIC dimensions come from their headers. Nothing is decoded and no other program runs.

use serde::Serialize;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use crate::{image, isobmff};

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub kind: &'static str, // "video" | "audio" | "image"
    pub container: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Frame rate as an exact rational ("60000/1001") and as a number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fps_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub video_profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_codec: Option<String>,
    pub has_audio: bool,
    /// Clockwise degrees the picture is turned for display (0, 90, 180, 270).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotation: Option<u32>,
    /// The picture is also flipped (a mirrored display matrix or EXIF orientation).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub mirrored: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creation_time: Option<String>,
    pub via: &'static str,
}

#[derive(Debug, PartialEq)]
pub enum ProbeError {
    NotFound(String),
    Unsupported(String),
    Unreadable(String),
}

impl ProbeError {
    pub fn code(&self) -> &'static str {
        match self {
            ProbeError::NotFound(_) => "not-found",
            ProbeError::Unsupported(_) => "unsupported",
            ProbeError::Unreadable(_) => "unreadable",
        }
    }
    pub fn message(&self) -> &str {
        match self {
            ProbeError::NotFound(m) | ProbeError::Unsupported(m) | ProbeError::Unreadable(m) => m,
        }
    }
}

pub fn io_error(e: io::Error) -> ProbeError {
    match e.kind() {
        io::ErrorKind::NotFound => ProbeError::NotFound("no such file".into()),
        io::ErrorKind::PermissionDenied => ProbeError::Unreadable("permission denied".into()),
        io::ErrorKind::UnexpectedEof => ProbeError::Unreadable("the file ends too early".into()),
        _ => ProbeError::Unreadable(e.to_string()),
    }
}

pub fn probe_path(path: &Path) -> Result<Probe, ProbeError> {
    // metadata() follows symlinks and never blocks; only regular files are opened (a FIFO or
    // device would block or never end).
    let meta = std::fs::metadata(path).map_err(io_error)?;
    if meta.is_dir() {
        return Err(ProbeError::Unsupported("it's a folder".into()));
    }
    if !meta.is_file() {
        return Err(ProbeError::Unsupported("it isn't a regular file".into()));
    }
    let mut file = File::open(path).map_err(io_error)?;
    probe_reader(&mut file, meta.len())
}

pub fn probe_reader<R: Read + Seek>(r: &mut R, len: u64) -> Result<Probe, ProbeError> {
    let mut head = [0u8; 16];
    let n = read_up_to(r, &mut head)?;
    let head = &head[..n];
    r.seek(SeekFrom::Start(0)).map_err(io_error)?;
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        return image::png(r);
    }
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return image::jpeg(r, len);
    }
    if n >= 8 && isobmff::looks_like(&head[4..8]) {
        return isobmff::probe(r, len);
    }
    Err(ProbeError::Unsupported("not a format Uncut can read yet".into()))
}

pub fn read_up_to<R: Read>(r: &mut R, buf: &mut [u8]) -> Result<usize, ProbeError> {
    let mut filled = 0;
    while filled < buf.len() {
        match r.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(k) => filled += k,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(io_error(e)),
        }
    }
    Ok(filled)
}

/// Seconds since 1904-01-01 (QuickTime epoch) to "YYYY-MM-DDTHH:MM:SSZ"; None for unset or pre-1970.
pub fn qt_time(seconds: u64) -> Option<String> {
    let unix = seconds.checked_sub(2_082_844_800)? as i64;
    if seconds == 0 {
        return None;
    }
    let days = unix.div_euclid(86_400);
    let secs = unix.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    Some(format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", secs / 3600, (secs / 60) % 60, secs % 60))
}

pub fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { gcd(b, a % b) }
}
