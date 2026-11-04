import Foundation

setvbuf(stdout, nil, _IOFBF, 1 << 20)
signal(SIGPIPE, SIG_DFL)

do {
  let options = try Options(CommandLine.arguments)
  switch options.command {
  case "matte": try runMatte(options)
  case "faces": try runFaces(options)
  case "track": try runTrack(options)
  case "version": print("uncut-vision 1")
  default: throw Failure(message: "There's no command \(options.command): matte, faces or track.")
  }
  exit(0)
} catch let failure as Failure {
  emit(["event": "error", "message": failure.message])
  exit(1)
} catch {
  emit(["event": "error", "message": error.localizedDescription])
  exit(1)
}
