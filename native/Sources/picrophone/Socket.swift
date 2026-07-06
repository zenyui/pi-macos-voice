import Foundation

/// Minimal unix-domain stream client. The extension owns the listening socket;
/// Picrophone.app connects out to it (because `open` detaches stdio). We write NDJSON
/// out and read newline-delimited control lines back.
final class UnixSocketClient {
    private let fd: Int32

    init?(path: String) {
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 { return nil }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = Array(path.utf8CString)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        if pathBytes.count > capacity { close(fd); return nil }
        withUnsafeMutablePointer(to: &addr.sun_path) { raw in
            raw.withMemoryRebound(to: CChar.self, capacity: capacity) { dst in
                for (i, b) in pathBytes.enumerated() { dst[i] = b }
            }
        }

        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let ok = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, len) }
        }
        if ok != 0 { close(fd); return nil }
    }

    func writeLine(_ s: String) {
        let bytes = Array((s + "\n").utf8)
        var offset = 0
        bytes.withUnsafeBytes { raw in
            let base = raw.baseAddress!
            while offset < bytes.count {
                let n = write(fd, base + offset, bytes.count - offset)
                if n <= 0 { return }
                offset += n
            }
        }
    }

    /// Read control lines on a background queue. `onClose` fires on EOF/error.
    func readLines(onLine: @escaping (String) -> Void, onClose: @escaping () -> Void) {
        let readFd = fd
        DispatchQueue.global(qos: .utility).async {
            var buffer = Data()
            var chunk = [UInt8](repeating: 0, count: 1024)
            while true {
                let n = chunk.withUnsafeMutableBytes { read(readFd, $0.baseAddress, 1024) }
                if n <= 0 { onClose(); return }
                buffer.append(contentsOf: chunk[0..<n])
                while let idx = buffer.firstIndex(of: 0x0a) {
                    let line = buffer.subdata(in: buffer.startIndex..<idx)
                    buffer.removeSubrange(buffer.startIndex...idx)
                    if let s = String(data: line, encoding: .utf8) {
                        onLine(s.trimmingCharacters(in: .whitespacesAndNewlines))
                    }
                }
            }
        }
    }

    func closeSocket() { close(fd) }
}
