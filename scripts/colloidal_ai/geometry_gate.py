"""Assay-independent geometric gates; never use C/T intensity to pick a card."""
import numpy as np


def center(region):return np.asarray(region['polygon'],np.float32).mean(0)


def direction_from_wells(windows,wells):
    count=len(windows)
    if count not in (1,3) or len(wells)!=count:
        return dict(status='unverified',reason='膜窗/加样孔数量不完整或不一致')
    if any(r['score']<.65 for r in windows+wells):
        return dict(status='unverified',reason='膜窗或加样孔候选证据不足')
    wc=np.asarray([center(r)for r in windows]);sc=np.asarray([center(r)for r in wells])
    vector=sc.mean(0)-wc.mean(0);distance=np.linalg.norm(vector)
    if distance<1:return dict(status='unverified',reason='加样孔与膜窗方向不确定')
    down=vector/distance;right=np.array([down[1],-down[0]])
    lengths=[];widths=[]
    for r in windows:
        p=np.asarray(r['polygon']);edges=np.roll(p,-1,axis=0)-p
        sizes=np.linalg.norm(edges,axis=1);axis=edges[int(np.argmax(sizes))]/max(sizes.max(),1e-8)
        if abs(np.dot(axis,down))<.85 or sizes.max()/max(sizes.min(),1)<2.3:
            return dict(status='unverified',reason='膜窗长轴与加样孔方向不一致')
        lengths.append(sizes.max());widths.append(sizes.min())
    length=float(np.median(lengths))
    if not .5*length<distance<3.2*length:
        return dict(status='unverified',reason='加样孔与膜窗相对距离不可靠')
    if count==3:
        if np.ptp(wc@down)>.35*length or np.ptp(sc@down)>.6*length:
            return dict(status='unverified',reason='三联膜窗或加样孔排列不一致')
        if np.diff(np.sort(wc@right)).min()<1.5*np.median(widths):
            return dict(status='unverified',reason='窗口碎片未形成三个独立膜窗')
    order=np.argsort(wc@right)
    return dict(status='verified_from_well_geometry',reason='膜窗与独立加样孔候选确认方向',
                down=down.tolist(),right=right.tolist(),window_order=order.tolist(),
                evidence_role='experimental_geometry_not_product_identity_or_assay_truth')
