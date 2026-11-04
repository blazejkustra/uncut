import AVFoundation
import CoreVideo
import ImageIO

/// One decoded frame: its picture and its presentation time in the source, in seconds.
struct Frame {
  let pixels: CVPixelBuffer
  let time: Double
}

/// The source frames that show during [start, end): the last frame starting at or before start
/// (+0.0001 s), then every frame starting before end, decoded with AVAssetReader.
final class FrameReader {
  static let epsilon = 0.0001

  let orientation: CGImagePropertyOrientation
  let width: Int
  let height: Int
  let fps: Double
  let start: Double
  let end: Double
  let expectedFrames: Int

  private let reader: AVAssetReader
  private let output: AVAssetReaderTrackOutput
  private var pending: Frame?
  private var finished = false

  init(path: String, start: Double, end: Double?) throws {
    guard FileManager.default.fileExists(atPath: path) else { throw Failure(message: "There's no file at \(path).") }
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    guard (try? blocking({ try await asset.load(.isReadable) })) == true else { throw FrameReader.unreadable(path) }
    guard let track = try? blocking({ try await asset.loadTracks(withMediaType: .video).first }) else { throw FrameReader.unreadable(path) }
    let duration = try blocking { try await asset.load(.duration) }.seconds
    let (rate, transform, natural) = try blocking { try await track.load(.nominalFrameRate, .preferredTransform, .naturalSize) }
    let stop = min(end ?? duration, duration.isFinite ? duration : (end ?? 0))
    guard start >= 0, stop > start else { throw Failure(message: "The range \(start) to \(stop) s is empty.") }
    self.start = start
    self.end = stop
    fps = rate > 0 ? Double(rate) : 30
    expectedFrames = max(1, Int(((stop - start) * fps).rounded()))
    orientation = FrameReader.orientation(of: transform)
    let display = natural.applying(transform)
    width = Int(abs(display.width).rounded())
    height = Int(abs(display.height).rounded())

    reader = try AVAssetReader(asset: asset)
    let settings: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
    output = AVAssetReaderTrackOutput(track: track, outputSettings: settings)
    output.alwaysCopiesSampleData = false
    reader.add(output)
    let from = CMTime(seconds: max(0, start - 1), preferredTimescale: 600_000)
    reader.timeRange = CMTimeRange(start: from, end: CMTime(seconds: stop, preferredTimescale: 600_000))
    guard reader.startReading() else { throw Failure(message: "Couldn't decode \(path): \(reader.error?.localizedDescription ?? "unknown error").") }
  }

  func cancel() { reader.cancelReading() }

  private static func unreadable(_ path: String) -> Failure {
    let kind = URL(fileURLWithPath: path).pathExtension.lowercased()
    let format = kind.isEmpty ? "This file's format" : "The .\(kind) format"
    return Failure(message: "\(format) isn't one the Apple Vision module can read (it reads what macOS plays: .mp4, .mov, .m4v), or the file has no video.")
  }

  /// The next frame of the range, or nil after its last.
  func next() throws -> Frame? {
    while !finished {
      guard let sample = output.copyNextSampleBuffer() else {
        finished = true
        if reader.status == .failed { throw Failure(message: "Decoding stopped: \(reader.error?.localizedDescription ?? "unknown error").") }
        return takePending()
      }
      guard let pixels = CMSampleBufferGetImageBuffer(sample) else { continue }
      let time = CMSampleBufferGetPresentationTimeStamp(sample).seconds
      let frame = Frame(pixels: pixels, time: time)
      if time <= start + FrameReader.epsilon {
        pending = frame
        continue
      }
      if time >= end - FrameReader.epsilon {
        finished = true
        reader.cancelReading()
        return takePending()
      }
      if let first = takePending() {
        pending = frame
        return first
      }
      return frame
    }
    return takePending()
  }

  private func takePending() -> Frame? {
    defer { pending = nil }
    return pending
  }

  private static func orientation(of t: CGAffineTransform) -> CGImagePropertyOrientation {
    switch (t.a, t.b, t.c, t.d) {
    case (0, 1, -1, 0): return .right
    case (0, -1, 1, 0): return .left
    case (-1, 0, 0, -1): return .down
    default: return .up
    }
  }
}

/// AVFoundation's async loading, waited for (the helper is a one-shot command line tool).
private func blocking<T>(_ work: @escaping () async throws -> T) throws -> T {
  var outcome: Result<T, Error>?
  let done = DispatchSemaphore(value: 0)
  Task {
    do {
      outcome = .success(try await work())
    } catch {
      outcome = .failure(error)
    }
    done.signal()
  }
  done.wait()
  return try outcome!.get()
}
