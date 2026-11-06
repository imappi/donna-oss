import AppKit
import Foundation
import PDFKit
import Vision

struct OcrLine {
  let text: String
  let x: CGFloat
  let midY: CGFloat
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
  FileHandle.standardError.write(Data("Missing PDF path.\n".utf8))
  exit(2)
}

let pdfURL = URL(fileURLWithPath: arguments[1])
let maxPages = arguments.count >= 3 ? max(1, Int(arguments[2]) ?? 12) : 12

guard let document = PDFDocument(url: pdfURL) else {
  FileHandle.standardError.write(Data("Could not open PDF.\n".utf8))
  exit(3)
}

func renderPage(_ page: PDFPage, scale: CGFloat = 2.0) -> CGImage? {
  let bounds = page.bounds(for: .mediaBox)
  let width = Int(bounds.width * scale)
  let height = Int(bounds.height * scale)
  guard width > 0, height > 0 else { return nil }

  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: width,
    pixelsHigh: height,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else {
    return nil
  }

  NSGraphicsContext.saveGraphicsState()
  guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    NSGraphicsContext.restoreGraphicsState()
    return nil
  }

  NSGraphicsContext.current = context
  NSColor.white.setFill()
  NSRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)).fill()

  context.cgContext.scaleBy(x: scale, y: scale)
  page.draw(with: .mediaBox, to: context.cgContext)
  NSGraphicsContext.restoreGraphicsState()

  return bitmap.cgImage
}

func recognizeLines(in image: CGImage) -> [String] {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = false

  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  do {
    try handler.perform([request])
  } catch {
    return []
  }

  let observations = request.results ?? []
  let items = observations.compactMap { observation -> OcrLine? in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty { return nil }
    return OcrLine(
      text: text,
      x: observation.boundingBox.minX,
      midY: observation.boundingBox.midY
    )
  }

  let sorted = items.sorted {
    if abs($0.midY - $1.midY) > 0.008 {
      return $0.midY > $1.midY
    }
    return $0.x < $1.x
  }

  var rows: [[OcrLine]] = []
  for item in sorted {
    if let index = rows.firstIndex(where: { row in
      guard let anchor = row.first else { return false }
      return abs(anchor.midY - item.midY) <= 0.008
    }) {
      rows[index].append(item)
    } else {
      rows.append([item])
    }
  }

  return rows.map { row in
    row.sorted { $0.x < $1.x }
      .map { $0.text }
      .joined(separator: " ")
      .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }.filter { !$0.isEmpty }
}

var output: [String] = []
let pageLimit = min(document.pageCount, maxPages)
for pageIndex in 0..<pageLimit {
  guard let page = document.page(at: pageIndex), let image = renderPage(page) else { continue }
  output.append(contentsOf: recognizeLines(in: image))
}

print(output.joined(separator: "\n"))
