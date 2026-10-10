// Draws Sage's app icon (a sparkle on a dark squircle) as a 1024×1024 PNG.
// usage: swift icon.swift out.png
import AppKit

let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext

// the tile: Apple's grid leaves a margin around an 824-point squircle
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let shape = CGPath(roundedRect: tile, cornerWidth: 185, cornerHeight: 185, transform: nil)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: NSColor.black.withAlphaComponent(0.35).cgColor)
ctx.addPath(shape)
ctx.setFillColor(NSColor.black.cgColor)
ctx.fillPath()
ctx.restoreGState()
ctx.saveGState()
ctx.addPath(shape)
ctx.clip()
let space = CGColorSpaceCreateDeviceRGB()
let bg = CGGradient(colorsSpace: space, colors: [
    NSColor(red: 0.13, green: 0.11, blue: 0.22, alpha: 1).cgColor,
    NSColor(red: 0.05, green: 0.05, blue: 0.09, alpha: 1).cgColor,
] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(bg, start: CGPoint(x: 0, y: size), end: CGPoint(x: size, y: 0), options: [])
let glow = CGGradient(colorsSpace: space, colors: [
    NSColor(red: 0.55, green: 0.42, blue: 1.0, alpha: 0.45).cgColor,
    NSColor(red: 0.55, green: 0.42, blue: 1.0, alpha: 0).cgColor,
] as CFArray, locations: [0, 1])!
ctx.drawRadialGradient(glow, startCenter: CGPoint(x: 512, y: 512), startRadius: 0, endCenter: CGPoint(x: 512, y: 512), endRadius: 420, options: [])

// the sparkle: four curved points
func sparkle(center c: CGPoint, radius r: CGFloat, waist w: CGFloat) -> CGPath {
    let p = CGMutablePath()
    let pts = [CGPoint(x: c.x, y: c.y + r), CGPoint(x: c.x + r, y: c.y), CGPoint(x: c.x, y: c.y - r), CGPoint(x: c.x - r, y: c.y)]
    p.move(to: pts[0])
    for i in 0..<4 {
        let next = pts[(i + 1) % 4]
        p.addQuadCurve(to: next, control: CGPoint(x: c.x + (pts[i].x - c.x + next.x - c.x) * w, y: c.y + (pts[i].y - c.y + next.y - c.y) * w))
    }
    p.closeSubpath()
    return p
}
let star = sparkle(center: CGPoint(x: 512, y: 512), radius: 300, waist: 0.12)
ctx.addPath(star)
ctx.clip()
let fg = CGGradient(colorsSpace: space, colors: [
    NSColor(red: 0.62, green: 0.50, blue: 1.0, alpha: 1).cgColor,
    NSColor(red: 1.0, green: 0.58, blue: 0.38, alpha: 1).cgColor,
] as CFArray, locations: [0, 1])!
ctx.drawLinearGradient(fg, start: CGPoint(x: 230, y: 800), end: CGPoint(x: 800, y: 230), options: [])
ctx.restoreGState()
// a small companion sparkle
ctx.saveGState()
ctx.addPath(sparkle(center: CGPoint(x: 735, y: 735), radius: 70, waist: 0.12))
ctx.setFillColor(NSColor(white: 1, alpha: 0.9).cgColor)
ctx.fillPath()
ctx.restoreGState()
image.unlockFocus()

let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
