"""Create an internal CPU candidate kit; no photos, annotations or credentials."""
import argparse,hashlib,json,shutil,zipfile
from pathlib import Path


README='''# 无定位板检测卡 D1 本地候选包

这是研发实测包，不是正式业务发布。它包含卡体定位、卡内窗孔模型、局部膜窗精定位、上下方向/正视从左到右排序、原图 C/T 测量及 T 可见性模型。

不读取卡面项目文字，不依赖定位板，不读取人工几何。项目来自选择；单检比较 C/T 深浅，三联采用既有 T 显色规则。时间未核实时只给图像解释；即使提供时间，此候选也不会输出正式 final_result，规则预览单列。

## 环境和校验

Mac ARM/Python 3.12 已在独立、无 PyTorch 环境验证。Linux 服务器尚未实机验证，不能把本机耗时视为服务器指标。安装包不含 Python 本体或平台 wheel；安装时从正常软件源获取锁定依赖。

```sh
python3 verify.py
python3 -m venv runtime
runtime/bin/python -m pip install -r requirements-cpu-lock.txt
```

## 启动独立采集与实测

数据目录请放在包外。默认只绑定本机，不改原业务服务或 hybrid-v4；Tailscale 使用本机真实虚拟网卡 IP。不要运行旧包和新包竞争同一端口。

```sh
PYTHON_BIN=runtime/bin/python sh start.sh /absolute/path/new-card-captures 127.0.0.1 55617
# 如需其他设备访问，使用经授权的私有访问路径。
```

先为每张实体卡建立记录：卡编号、真实项目、设备、批次及参考来源。同卡多拍保持编号一致；不同背景逐次注明。阴阳性、C/T可见性、照片情况为独立参考，不送入模型；未知保持未知，不得拿模型输出回填。每次上传保存原始字节与独立记录，完全同字节只共用原图文件，拍摄高度/角度不同不会被近似去重。输入损坏也保留失败收据。不在线更新权重。

## 单图命令

```sh
runtime/bin/python bundle/code/candidate_runtime.py --bundle bundle --image /absolute/photo.jpg --project lean_meat_triplex --output result.json
runtime/bin/python bundle/code/candidate_runtime.py --bundle bundle --image /absolute/photo.jpg --project carbofuran --output result.json
python3 acceptance_audit.py --data /absolute/path/new-card-captures --output acceptance.json
```

项目也可以选择包内 projects.json 的其他实际项目。不给项目仅作家族几何诊断，不推断项目或判定合格。C/T幅度是未经浓度/视觉深浅校准的图像测量，T模型分数不是经临床校准的概率。

## 当前限制与回退

P0423第2窗弱T仍漏检；严格几何仍有失败；真实C缺失、不可读、多卡等独立负类不足，历史“截断卡”分类存在疑点待单独复核。旧照片来自重复拍摄，不是568张独立实体卡。单检强度参考、有效读数时间和独立新卡验收尚未完成，因此不得据此自动批准食品样本合格。

本包没有改原业务服务。回退只需停止此终端/独立服务，保留采集数据，并继续原业务版本；不要删除旧 run、照片、人工记录或覆盖旧权重。模型或代码哈希不符时启动拒绝。包内没有照片、完整人工标签、数据库、账号或密钥。

上游与谱系：沿用本项目 A0 MobileNetV2 U-Net卡体ONNX、已有监督ROI模型、局部膜窗继续训练权重及既有实验测量/说明书规则；没有新下载第三方源码、没有RL。内部研发使用；对外分发前继续核验原项目及依赖许可、说明书适用性。
'''

VERIFY='''import hashlib,json\nfrom pathlib import Path\np=Path(__file__).resolve().parent\nd=json.loads((p/'package_manifest.json').read_text())\nfor name,want in d['files'].items():\n actual=hashlib.sha256((p/name).read_bytes()).hexdigest()\n if actual!=want:raise SystemExit('HASH MISMATCH '+name)\nprint('Verified',len(d['files']),'files; research candidate only')\n'''


def main():
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--bundle',required=True,type=Path);ap.add_argument('--output',required=True,type=Path)
    ap.add_argument('--requirements',required=True,type=Path);a=ap.parse_args();a.output.mkdir(parents=True,exist_ok=False)
    shutil.copytree(a.bundle,a.output/'bundle');shutil.copyfile(a.requirements,a.output/'requirements-cpu-lock.txt')
    shutil.copyfile(Path(__file__).with_name('acceptance_audit.py'),a.output/'acceptance_audit.py')
    (a.output/'README.md').write_text(README);(a.output/'verify.py').write_text(VERIFY)
    (a.output/'start.sh').write_text('''#!/bin/sh\nset -eu\nKIT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\n"${PYTHON_BIN:-python3}" "$KIT_ROOT/verify.py"\nexec "${PYTHON_BIN:-python3}" "$KIT_ROOT/bundle/code/candidate_server.py" --bundle "$KIT_ROOT/bundle" --data "${1:?Provide a data directory outside the kit}" --host "${2:-127.0.0.1}" --port "${3:-55617}"\n''')
    files={str(p.relative_to(a.output)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(a.output.rglob('*')) if p.is_file()}
    (a.output/'package_manifest.json').write_text(json.dumps(dict(schema_version=1,files=files,production_approved=False,independent_acceptance=False,contains_original_photos=False),indent=2)+'\n')
    archive=a.output.with_suffix('.zip')
    if archive.exists():raise ValueError('archive exists')
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
        for p in sorted(a.output.rglob('*')):
            if p.is_file():z.write(p,str(Path(a.output.name)/p.relative_to(a.output)))
    print(json.dumps(dict(files=len(files),archive=str(archive),bytes=archive.stat().st_size,sha256=hashlib.sha256(archive.read_bytes()).hexdigest())))

if __name__=='__main__':main()
