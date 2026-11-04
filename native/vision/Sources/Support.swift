import Foundation

struct Failure: Error {
  let message: String
}

struct Options {
  private var values: [String: String] = [:]
  let command: String

  init(_ argv: [String]) throws {
    guard argv.count >= 2 else { throw Failure(message: "Usage: uncut-vision matte|faces|track --input <file> [options]") }
    command = argv[1]
    var i = 2
    while i < argv.count {
      let key = argv[i]
      guard key.hasPrefix("--"), i + 1 < argv.count else { throw Failure(message: "Unexpected argument \(key).") }
      values[String(key.dropFirst(2))] = argv[i + 1]
      i += 2
    }
  }

  func string(_ key: String) -> String? { values[key] }

  func required(_ key: String) throws -> String {
    guard let value = values[key], !value.isEmpty else { throw Failure(message: "Pass --\(key).") }
    return value
  }

  func number(_ key: String) throws -> Double? {
    guard let text = values[key] else { return nil }
    guard let value = Double(text), value.isFinite else { throw Failure(message: "--\(key) must be a number, got \(text).") }
    return value
  }

  func box(_ key: String) throws -> CGRect {
    let parts = try required(key).split(separator: ",").compactMap { Double($0) }
    guard parts.count == 4, parts[2] > 0, parts[3] > 0 else { throw Failure(message: "--\(key) must be x,y,w,h (0 to 1).") }
    return CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
  }
}

private let stderrLock = NSLock()

func emit(_ event: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) else { return }
  stderrLock.lock()
  FileHandle.standardError.write(data + Data([0x0A]))
  stderrLock.unlock()
}

func writeAll(_ pointer: UnsafeRawPointer, _ count: Int) throws {
  var offset = 0
  while offset < count {
    let n = write(1, pointer + offset, count - offset)
    if n < 0 {
      if errno == EINTR { continue }
      throw Failure(message: "The matte's output closed early.")
    }
    offset += n
  }
}

func printJson(_ value: Any) throws {
  let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  try data.withUnsafeBytes { try writeAll($0.baseAddress!, data.count) }
  try writeAll([UInt8(0x0A)], 1)
}

/// Vision's normalised rectangle (origin bottom-left) as the contract's (origin top-left), cut to the
/// picture (trackers report boxes reaching past its edges) and rounded; nil when nothing is left inside.
func topLeft(_ r: CGRect) -> [String: Double]? {
  let inside = r.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
  guard !inside.isNull, inside.width > 0, inside.height > 0 else { return nil }
  let round4 = { (v: Double) in (v * 10000).rounded() / 10000 }
  return ["x": round4(inside.minX), "y": round4(1 - inside.maxY), "w": round4(inside.width), "h": round4(inside.height)]
}

func visionRect(fromTopLeft r: CGRect) -> CGRect {
  CGRect(x: r.minX, y: 1 - r.minY - r.height, width: r.width, height: r.height)
}

func seconds(_ t: Double) -> Double { (t * 1_000_000).rounded() / 1_000_000 }

/// Progress on stderr, at most every 1 % of the range.
final class Progress {
  private let total: Int
  private var last = -1

  init(total: Int) { self.total = max(total, 1) }

  func done(_ count: Int) {
    let pct = min(100, count * 100 / total)
    if pct == last { return }
    last = pct
    emit(["event": "progress", "done": count, "total": total])
  }
}
