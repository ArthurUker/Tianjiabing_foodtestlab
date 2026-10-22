#!/usr/bin/env bash
# 安装/修复服务端识别运行时（胶体金 v5）。
# 仅 Node 后端使用：无端口、无数据库访问；安装目录默认在数据盘。
# 用法： sudo bash scripts/install-colloidal-recognizer.sh [安装目录]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-/mnt/datadisk0/foodsentinel/recognizer}"
PY="${PYTHON_BIN:-python3}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> 目标目录: $TARGET"
mkdir -p "$TARGET"/{core/lab,site-packages}

echo "==> 下载固定版本依赖（与浏览器版一致）"
# 版本在此固定；升级算法需同时更新 core.json 与这些版本，并重新验收。
fetch() {
  local name="$1" version="$2" flavor="$3"
  local url
  url="$("$PY" - "$name" "$version" "$flavor" <<'PY'
import json, sys, urllib.request
name, version, flavor = sys.argv[1:4]
data = json.load(urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json", timeout=60))
for item in data["urls"]:
    f = item["filename"]
    if "manylinux" in f and "x86_64" in f and (flavor in f) and f.endswith(".whl"):
        print(item["url"]); break
PY
)"
  [ -n "$url" ] || { echo "找不到 $name $version 的 manylinux wheel"; exit 1; }
  curl -fsSL --retry 3 "$url" -o "$WORK/$name.whl"
  unzip -oq "$WORK/$name.whl" -d "$TARGET/site-packages"
  echo "    $name $version"
}

fetch numpy 2.2.5 cp310
fetch scipy 1.14.1 cp310
fetch pillow 11.3.0 cp310
fetch opencv-python-headless 4.11.0.86 abi3

echo "==> 展开固定提交的识别核心"
"$PY" - "$ROOT" "$TARGET" <<'PY'
import json, pathlib, sys
root, target = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
bundle = json.loads((root / "frontend/vendor/colloidal/core.json").read_text())
for name, source in bundle["files"].items():
    path = target / "core" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source)
print(f"    core commit {bundle['commit']} ({len(bundle['files'])} files)")
PY

cp "$ROOT/backend/recognizer/worker.py" "$TARGET/worker.py"
cp "$ROOT/backend/recognizer/server_entry.py" "$TARGET/core/server_entry.py"
cp "$ROOT/backend/recognizer/process_log.py" "$TARGET/core/process_log.py"

if id foodsentinel >/dev/null 2>&1; then
  chown -R foodsentinel:foodsentinel "$TARGET"
fi
chmod -R a+rX "$TARGET"

echo "==> 冒烟测试"
echo '{"op":"ping"}' | COLLOIDAL_RECOGNIZER_HOME="$TARGET" "$PY" "$TARGET/worker.py" | tail -2
echo "==> 完成。服务端环境变量：COLLOIDAL_RECOGNIZER_HOME=$TARGET"
