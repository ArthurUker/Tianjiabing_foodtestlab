"""Model-only window/well pairing; no image label, assay or C/T input."""
import numpy as np
from scipy.optimize import linear_sum_assignment


def pair_direction(windows, candidates):
    if len(windows) not in (1, 3):
        return dict(status='unverified', reason='window_count_not_single_or_triplex')
    if any(w['score'] < .65 for w in windows):
        return dict(status='unverified', reason='window_confidence')
    centers=[]; axes=[]; lengths=[]; widths=[]
    for w in windows:
        p=np.asarray(w['polygon'], float); edges=np.roll(p,-1,axis=0)-p
        sizes=np.linalg.norm(edges,axis=1); i=int(np.argmax(sizes))
        centers.append(p.mean(0)); axes.append(edges[i]/max(sizes[i],1e-8))
        lengths.append(sizes.max()); widths.append(sizes.min())
    axes=np.asarray(axes);axes=np.where((axes@axes[0])[:,None]<0,-axes,axes)
    axis=axes.mean(0);axis/=max(np.linalg.norm(axis),1e-8)
    if np.min(np.abs(axes@axis))<.85:
        return dict(status='unverified',reason='inconsistent_window_axes')
    wc=np.asarray(centers); length=float(np.median(lengths)); width=float(np.median(widths))
    wells=[];well_indices=[]
    for candidate_index,w in enumerate(candidates):
        p=np.asarray(w['polygon'],float);sizes=np.linalg.norm(np.roll(p,-1,axis=0)-p,axis=1)
        if w['score']>=.65 and .05*length<=sizes.max()<=.8*length and sizes.min()>0:
            wells.append(w);well_indices.append(candidate_index)
    if len(wells)<len(windows):
        return dict(status='unverified',reason='insufficient_independent_wells')
    sc=np.asarray([np.asarray(w['polygon']).mean(0) for w in wells]);solutions=[]
    for sign in (1,-1):
        down=axis*sign;right=np.array([down[1],-down[0]])
        delta=sc[None]-wc[:,None];along=delta@down;across=np.abs(delta@right)
        limit=np.maximum(np.asarray(widths)*2,.2*np.asarray(lengths))[:,None]
        valid=(along>.5*np.asarray(lengths)[:,None])&(along<3.2*np.asarray(lengths)[:,None])&(across<limit)
        cost=across/limit+.1*np.abs(np.log(np.maximum(along,1e-8)/length))
        ii,jj=linear_sum_assignment(np.where(valid,cost,1e6))
        if len(ii)!=len(windows) or not valid[ii,jj].all():continue
        chosen=sc[jj]
        if len(windows)==3:
            if np.ptp(wc@down)>.35*length or np.ptp(chosen@down)>.6*length:continue
            if np.diff(np.sort(wc@right)).min()<1.5*width:continue
        # Recompute direction from the one-to-one selected physical ports.
        vector=chosen.mean(0)-wc.mean(0);down=vector/np.linalg.norm(vector)
        if np.min(np.abs(axes@down))<.85:continue
        right=np.array([down[1],-down[0]])
        solutions.append(dict(status='verified_from_well_geometry',down=down.tolist(),right=right.tolist(),
            window_order=np.argsort(wc@right).tolist(),well_indices=[well_indices[index] for index in jj],
            pairing_cost=float(cost[ii,jj].mean()),reason='independent_one_to_one_axial_well_pairs',
            evidence_role='experimental_geometry_not_assay_truth'))
    if len(solutions)!=1:
        return dict(status='unverified',reason='ambiguous_polarity' if solutions else 'no_axial_well_assignment')
    return solutions[0]
