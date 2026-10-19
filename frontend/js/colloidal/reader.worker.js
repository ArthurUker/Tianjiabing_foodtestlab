// A dedicated worker executes the selected Python pipeline, never the benchmark.
let ready;
async function initialize() {
    const root = new URL('/vendor/colloidal/', self.location.origin);
    const { loadPyodide } = await import(new URL('runtime/pyodide.mjs', root).href);
    const py = await loadPyodide({ indexURL: new URL('runtime/', root).href });
    await py.loadPackage(['numpy', 'scipy', 'pillow', 'opencv-python']);
    const bundle = await (await fetch(new URL('core.json', root))).json();
    if (bundle.commit !== 'a0e9d274f5df2bc1ec85f4b6df04f4f81b4c98da') throw new Error('识别核心版本不匹配');
    py.FS.mkdirTree('/reader/lab');
    py.runPython('import hashlib');
    for (const [name, content] of Object.entries(bundle.files)) {
        py.globals.set('__core_text', content);
        const hash = py.runPython("hashlib.sha256(__core_text.encode('utf8')).hexdigest()");
        if (hash !== bundle.hashes[name]) throw new Error('识别核心校验失败');
        py.FS.writeFile('/reader/' + name, content);
    }
    py.globals.delete('__core_text');
    const adapter = await (await fetch(new URL('./browser_entry.py', import.meta.url))).text();
    py.FS.writeFile('/reader/browser_entry.py', adapter);
    py.runPython("import sys; sys.path.insert(0, '/reader')\nfrom browser_entry import recognize_original, image_metadata\nimport cv2\nassert hasattr(cv2.aruco, 'ArucoDetector')");
    return py;
}
self.onmessage = async ({ data }) => {
    const { id, bytes, projectId, elapsedSeconds, inputMode } = data;
    try {
        ready ||= initialize();
        const py = await ready;
        const fn = py.globals.get('recognize_original');
        try {
            const metadataFn = py.globals.get('image_metadata');
            let metadata;
            try { metadata = JSON.parse(metadataFn(new Uint8Array(bytes))); }
            catch { self.postMessage({ id, result: { status: 'decode_failed', error: '无法解码原照片或超过4000万像素，请使用JPG、PNG或WebP', channels: [] } }); return; }
            finally { metadataFn.destroy(); }
            let result;
            if (metadata.format === 'JPEG') {
                // Native Pillow uses libjpeg-turbo. Pyodide's libjpeg9 and
                // platform canvas decoders have different chroma upsampling.
                // Use one pinned WASM decoder on all browsers, preserving
                // original bytes and keeping v5 geometry/measurement unchanged.
                const { default: decode } = await import('/vendor/colloidal/runtime/jpeg/decode.js');
                const image = await decode(bytes, { preserveOrientation: true });
                result = JSON.parse(fn(new Uint8Array(bytes), projectId, JSON.stringify(elapsedSeconds), inputMode, image.data, image.width, image.height));
                result.decoder = 'mozjpeg-jsquash-1.6.0';
            } else {
                result = JSON.parse(fn(new Uint8Array(bytes), projectId, JSON.stringify(elapsedSeconds), inputMode));
                result.decoder = 'pillow-pyodide-0.28.3';
            }
            result.runtime = 'pyodide-0.28.3-jpeg-1.6.0-r1';
            self.postMessage({ id, result });
        } finally { fn.destroy(); }
    } catch (error) {
        const detail = String(error.message || error).trim().split('\n').at(-1).slice(0, 180);
        self.postMessage({ id, result: { status: 'engine_error', error: `识别运行异常：${detail}`, channels: [] } });
    }
};
