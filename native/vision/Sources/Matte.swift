import CoreImage
import CoreVideo
import Vision

enum MatteMode: String {
  case person
  case subject
}

/// A raw mask from Vision for one frame, at whatever size Vision made it.
protocol MaskSource {
  func mask(for frame: Frame, orientation: CGImagePropertyOrientation) throws -> CIImage?
}

final class PersonMask: MaskSource {
  private let request: VNGeneratePersonSegmentationRequest
  private let sequence = VNSequenceRequestHandler()

  init() {
    request = VNGeneratePersonSegmentationRequest()
    request.qualityLevel = .accurate
    request.outputPixelFormat = kCVPixelFormatType_OneComponent8
  }

  func mask(for frame: Frame, orientation: CGImagePropertyOrientation) throws -> CIImage? {
    try sequence.perform([request], on: frame.pixels, orientation: orientation)
    guard let buffer = request.results?.first?.pixelBuffer else { return nil }
    return CIImage(cvPixelBuffer: buffer, options: [.colorSpace: NSNull()])
  }
}

@available(macOS 14.0, *)
final class SubjectMask: MaskSource {
  private let request = VNGenerateForegroundInstanceMaskRequest()

  func mask(for frame: Frame, orientation: CGImagePropertyOrientation) throws -> CIImage? {
    let handler = VNImageRequestHandler(cvPixelBuffer: frame.pixels, orientation: orientation)
    try handler.perform([request])
    guard let observation = request.results?.first, !observation.allInstances.isEmpty else { return nil }
    let buffer = try observation.generateScaledMaskForImage(forInstances: observation.allInstances, from: handler)
    return CIImage(cvPixelBuffer: buffer, options: [.colorSpace: NSNull()])
  }
}

func maskSource(_ mode: MatteMode) throws -> MaskSource {
  switch mode {
  case .person:
    return PersonMask()
  case .subject:
    guard #available(macOS 14.0, *) else { throw Failure(message: "Subject cutout needs macOS 14 or later.") }
    return SubjectMask()
  }
}

/// Flicker damping: where the new mask is close to the running one it is blended in, where it
/// moved a lot (a real edge moving) it is taken as is, so smoothing leaves no trail.
struct TemporalSmoother {
  static let blend: Float = 0.5
  static let jump: Float = 48

  private var state: [Float] = []

  mutating func apply(_ pixels: inout [UInt8]) {
    if state.count != pixels.count {
      state = pixels.map(Float.init)
      return
    }
    for i in 0..<pixels.count {
      let now = Float(pixels[i])
      let before = state[i]
      let next = abs(now - before) > TemporalSmoother.jump ? now : before + (now - before) * TemporalSmoother.blend
      state[i] = next
      pixels[i] = UInt8(next.rounded())
    }
  }
}

/// Raw 8-bit grey frames of the matte (white = keep), at width × height, on stdout.
func runMatte(_ options: Options) throws {
  guard let mode = MatteMode(rawValue: try options.required("mode")) else { throw Failure(message: "--mode must be person or subject.") }
  let reader = try FrameReader(path: try options.required("input"), start: try options.number("start") ?? 0, end: try options.number("end"))
  let width = Int(try options.number("width") ?? Double(reader.width))
  let height = Int(try options.number("height") ?? Double(reader.height))
  guard width > 0, height > 0, width <= 16384, height <= 16384 else { throw Failure(message: "The matte size \(width)×\(height) isn't usable.") }
  let source = try maskSource(mode)
  let context = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull(), .cacheIntermediates: false])
  let size = CGSize(width: width, height: height)
  var smoother = TemporalSmoother()
  var pixels = [UInt8](repeating: 0, count: width * height)
  let progress = Progress(total: reader.expectedFrames)
  emit(["event": "start", "width": width, "height": height, "fps": reader.fps, "frames": reader.expectedFrames, "orientation": reader.orientation.rawValue])
  var count = 0
  while let frame = try autoreleasepool(invoking: { try reader.next() }) {
    try autoreleasepool {
      if let mask = try source.mask(for: frame, orientation: reader.orientation) {
        render(mask, into: &pixels, size: size, context: context)
      } else {
        for i in 0..<pixels.count { pixels[i] = 0 }
      }
    }
    smoother.apply(&pixels)
    try pixels.withUnsafeBytes { try writeAll($0.baseAddress!, $0.count) }
    emit(["event": "frame", "index": count, "t": seconds(frame.time)])
    count += 1
    progress.done(count)
  }
  emit(["event": "done", "frames": count])
}

private func render(_ mask: CIImage, into pixels: inout [UInt8], size: CGSize, context: CIContext) {
  let extent = mask.extent
  let scaled = mask
    .transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
    .transformed(by: CGAffineTransform(scaleX: size.width / extent.width, y: size.height / extent.height))
    .clampedToExtent()
    .cropped(to: CGRect(origin: .zero, size: size))
  pixels.withUnsafeMutableBytes { buffer in
    context.render(scaled, toBitmap: buffer.baseAddress!, rowBytes: Int(size.width), bounds: CGRect(origin: .zero, size: size), format: .L8, colorSpace: nil)
  }
}
