import Vision

/// A face followed across frames: Vision's tracker carries it between detections.
private final class FaceTrack {
  let id: Int
  var box: CGRect
  var confidence: Float
  var missed = 0
  private(set) var request: VNTrackObjectRequest

  init(id: Int, box: CGRect, confidence: Float) {
    self.id = id
    self.box = box
    self.confidence = confidence
    request = FaceTrack.tracker(at: box)
  }

  private static func tracker(at box: CGRect) -> VNTrackObjectRequest {
    let request = VNTrackObjectRequest(detectedObjectObservation: VNDetectedObjectObservation(boundingBox: box))
    request.trackingLevel = .accurate
    return request
  }

  /// Vision keeps a tracker alive (at most 32 per handler) until it sees a request's last frame.
  func end(on frame: Frame, orientation: CGImagePropertyOrientation, with sequence: VNSequenceRequestHandler, warnings: inout Warnings) {
    request.isLastFrame = true
    do {
      try sequence.perform([request], on: frame.pixels, orientation: orientation)
    } catch {
      warnings.note("Ending a face tracker failed: \(error.localizedDescription)")
    }
  }

  /// A detection matched this face: its box is the detection's. The tracker is replaced (the old one
  /// ended) only when it drifted from it, since a reseeded observation holds a tracker slot of its own.
  func matched(_ box: CGRect, confidence: Float, frame: Frame, orientation: CGImagePropertyOrientation, sequence: VNSequenceRequestHandler, warnings: inout Warnings) {
    let drifted = iou(self.box, box) < FaceTrack.reseedBelow
    self.box = box
    self.confidence = confidence
    missed = 0
    guard drifted else { return }
    end(on: frame, orientation: orientation, with: sequence, warnings: &warnings)
    request = FaceTrack.tracker(at: box)
  }

  static let reseedBelow: CGFloat = 0.6
}

private func iou(_ a: CGRect, _ b: CGRect) -> CGFloat {
  let inter = a.intersection(b)
  if inter.isNull || inter.isEmpty { return 0 }
  let shared = inter.width * inter.height
  return shared / (a.width * a.height + b.width * b.height - shared)
}

/// Pairs each detection with the predicted track it overlaps most (greedy, best overlap first).
private func match(_ detections: [VNFaceObservation], _ tracks: [FaceTrack], minimum: CGFloat) -> [(Int, Int)] {
  var pairs: [(score: CGFloat, detection: Int, track: Int)] = []
  for (d, face) in detections.enumerated() {
    for (t, track) in tracks.enumerated() {
      let score = iou(face.boundingBox, track.box)
      if score >= minimum { pairs.append((score, d, t)) }
    }
  }
  var usedDetections = Set<Int>()
  var usedTracks = Set<Int>()
  var matched: [(Int, Int)] = []
  for pair in pairs.sorted(by: { $0.score > $1.score }) where !usedDetections.contains(pair.detection) && !usedTracks.contains(pair.track) {
    usedDetections.insert(pair.detection)
    usedTracks.insert(pair.track)
    matched.append((pair.detection, pair.track))
  }
  return matched
}

/// Each distinct problem once on stderr, for the plugin's log.
struct Warnings {
  private var seen = Set<String>()

  mutating func note(_ message: String) {
    if seen.insert(message).inserted { emit(["event": "warning", "message": message]) }
  }
}

/// Face boxes per frame with ids that stay with a face while it's in view (JSON on stdout).
func runFaces(_ options: Options) throws {
  let maxMissed = 15
  let keepConfidence: Float = 0.5
  let reader = try FrameReader(path: try options.required("input"), start: try options.number("start") ?? 0, end: try options.number("end"))
  let sequence = VNSequenceRequestHandler()
  let detect = VNDetectFaceRectanglesRequest()
  let progress = Progress(total: reader.expectedFrames)
  var tracks: [FaceTrack] = []
  var nextId = 1
  var warnings = Warnings()
  var frames: [[String: Any]] = []
  while let frame = try autoreleasepool(invoking: { try reader.next() }) {
    try autoreleasepool {
      for track in tracks {
        do {
          try sequence.perform([track.request], on: frame.pixels, orientation: reader.orientation)
        } catch {
          warnings.note("A face tracker failed: \(error.localizedDescription)")
        }
        guard let seen = track.request.results?.first as? VNDetectedObjectObservation else {
          track.confidence = 0
          continue
        }
        track.box = seen.boundingBox
        track.confidence = seen.confidence
        track.request.inputObservation = seen
      }
      try VNImageRequestHandler(cvPixelBuffer: frame.pixels, orientation: reader.orientation).perform([detect])
      let detections = detect.results ?? []
      let pairs = match(detections, tracks, minimum: 0.3)
      let matchedTracks = Set(pairs.map(\.1))
      let matchedDetections = Set(pairs.map(\.0))
      for (d, t) in pairs {
        tracks[t].matched(detections[d].boundingBox, confidence: detections[d].confidence, frame: frame, orientation: reader.orientation, sequence: sequence, warnings: &warnings)
      }
      for (t, track) in tracks.enumerated() where !matchedTracks.contains(t) { track.missed += 1 }
      let gone = { (track: FaceTrack) in track.missed > maxMissed || (track.missed > 0 && track.confidence < keepConfidence) }
      for track in tracks where gone(track) { track.end(on: frame, orientation: reader.orientation, with: sequence, warnings: &warnings) }
      tracks.removeAll(where: gone)
      for (d, face) in detections.enumerated() where !matchedDetections.contains(d) {
        tracks.append(FaceTrack(id: nextId, box: face.boundingBox, confidence: face.confidence))
        nextId += 1
      }
      let faces = tracks.compactMap { track -> [String: Any]? in
        guard var face: [String: Any] = topLeft(track.box) else { return nil }
        face["id"] = track.id
        face["confidence"] = (Double(track.confidence) * 1000).rounded() / 1000
        return face
      }
      frames.append(["t": seconds(frame.time), "faces": faces])
    }
    progress.done(frames.count)
  }
  try printJson(["width": reader.width, "height": reader.height, "fps": reader.fps, "start": reader.start, "end": reader.end, "frames": frames])
}

/// One object followed from a box at --at until the tracker loses it (JSON on stdout).
func runTrack(_ options: Options) throws {
  let lostBelow: Float = 0.3
  let at = try options.number("at") ?? 0
  let reader = try FrameReader(path: try options.required("input"), start: at, end: try options.number("end"))
  let start = visionRect(fromTopLeft: try options.box("box"))
  guard let startBox = topLeft(start) else { throw Failure(message: "--box must be inside the picture.") }
  let request = VNTrackObjectRequest(detectedObjectObservation: VNDetectedObjectObservation(boundingBox: start))
  request.trackingLevel = .accurate
  let sequence = VNSequenceRequestHandler()
  let progress = Progress(total: reader.expectedFrames)
  var frames: [[String: Any]] = []
  var lost = false
  while !lost, let frame = try autoreleasepool(invoking: { try reader.next() }) {
    if frames.isEmpty {
      try sequence.perform([request], on: frame.pixels, orientation: reader.orientation)
      if let seen = request.results?.first as? VNDetectedObjectObservation { request.inputObservation = seen }
      var first: [String: Any] = startBox
      first["t"] = seconds(frame.time)
      first["confidence"] = 1
      frames.append(first)
      progress.done(frames.count)
      continue
    }
    try autoreleasepool {
      try sequence.perform([request], on: frame.pixels, orientation: reader.orientation)
      guard let seen = request.results?.first as? VNDetectedObjectObservation, seen.confidence >= lostBelow, var entry = topLeft(seen.boundingBox) else {
        frames.append(["t": seconds(frame.time), "lost": true])
        lost = true
        return
      }
      request.inputObservation = seen
      entry["t"] = seconds(frame.time)
      entry["confidence"] = (Double(seen.confidence) * 1000).rounded() / 1000
      frames.append(entry)
    }
    progress.done(frames.count)
  }
  if lost { reader.cancel() }
  try printJson(["width": reader.width, "height": reader.height, "fps": reader.fps, "start": reader.start, "end": reader.end, "frames": frames])
}
