//! uncut-media: the media core helper process (D42). The server spawns it on demand and
//! talks newline-delimited JSON over stdio: one request per line, one reply per line.
//! stdout carries only replies; anything diagnostic goes to stderr.

use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::Path;

mod image;
mod isobmff;
mod probe;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Answers one request line. Never panics on bad input: every line gets a reply.
pub fn handle_line(line: &str) -> Value {
    let request: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return error(Value::Null, "parse_error", &format!("invalid JSON: {e}")),
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    match request.get("method").and_then(Value::as_str) {
        Some("version") => json!({ "id": id, "result": { "version": VERSION } }),
        Some("probe") => match request.pointer("/params/path").and_then(Value::as_str) {
            // A parser bug must cost one file, not the helper and the rest of the batch.
            Some(path) => match std::panic::catch_unwind(|| probe::probe_path(Path::new(path))) {
                Ok(Ok(result)) => json!({ "id": id, "result": result }),
                Ok(Err(e)) => error(id, e.code(), e.message()),
                Err(_) => error(id, "unreadable", "the file couldn't be read (its structure confused the reader)"),
            },
            None => error(id, "invalid_request", "probe needs params.path"),
        },
        Some(method) => error(id, "unknown_method", &format!("unknown method: {method}")),
        None => error(id, "invalid_request", "missing \"method\""),
    }
}

fn error(id: Value, code: &str, message: &str) -> Value {
    json!({ "id": id, "error": { "code": code, "message": message } })
}

fn main() {
    // Panics are caught per request (see handle_line); keep their messages off stdout/stderr noise.
    std::panic::set_hook(Box::new(|info| eprintln!("uncut-media: {info}")));
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--version") {
        println!("uncut-media {VERSION}");
        return;
    }
    // `uncut-media probe <path>`: the same answer as the JSON method, for people and timing.
    if args.get(1).map(String::as_str) == Some("probe") {
        let Some(path) = args.get(2) else {
            eprintln!("usage: uncut-media probe <path>");
            std::process::exit(2);
        };
        match probe::probe_path(Path::new(path)) {
            Ok(result) => println!("{}", serde_json::to_string(&result).unwrap()),
            Err(e) => {
                println!("{}", json!({ "error": { "code": e.code(), "message": e.message() } }));
                std::process::exit(1);
            }
        }
        return;
    }
    serve(io::stdin().lock(), io::stdout().lock());
}

/// Replies to every line until EOF. Lines are read as bytes so one undecodable line gets an
/// error reply instead of ending the loop.
pub fn serve(mut input: impl BufRead, mut output: impl Write) {
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match input.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let reply = match std::str::from_utf8(&buf) {
            Ok(line) if line.trim().is_empty() => continue,
            Ok(line) => handle_line(line),
            Err(_) => error(Value::Null, "invalid_utf8", "request line is not valid UTF-8"),
        };
        if writeln!(output, "{reply}").and_then(|_| output.flush()).is_err() {
            break; // the parent went away
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_replies_with_crate_version() {
        let reply = handle_line(r#"{"id":1,"method":"version"}"#);
        assert_eq!(reply, json!({ "id": 1, "result": { "version": "0.0.1" } }));
    }

    #[test]
    fn unknown_method_is_an_error_with_the_same_id() {
        let reply = handle_line(r#"{"id":7,"method":"decode"}"#);
        assert_eq!(reply["id"], 7);
        assert_eq!(reply["error"]["code"], "unknown_method");
        assert!(reply.get("result").is_none());
    }

    #[test]
    fn invalid_utf8_gets_an_error_and_serving_continues() {
        let mut input: Vec<u8> = b"{\"id\":1,\"method\":\"\xff\xfe\"}\n".to_vec();
        input.extend_from_slice(b"{\"id\":2,\"method\":\"version\"}\n");
        let mut output = Vec::new();
        serve(&input[..], &mut output);
        let replies: Vec<Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0]["error"]["code"], "invalid_utf8");
        assert_eq!(replies[1], json!({ "id": 2, "result": { "version": "0.0.1" } }));
    }

    #[test]
    fn bad_json_is_a_parse_error() {
        let reply = handle_line("not json");
        assert_eq!(reply["id"], Value::Null);
        assert_eq!(reply["error"]["code"], "parse_error");
    }
}
