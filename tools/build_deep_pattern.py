#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_deep_pattern.py — สร้าง data/deep_pattern.json (Autoencoder anomaly score)

ไม่แตะ data/data.json เลย (ไฟล์นี้เขียนเฉพาะ data/deep_pattern.json)
ก่อนฝึกโมเดล สคริปต์ต้อง "พิสูจน์" ว่าฟีเจอร์และลำดับระเบียนตรงกับที่ใช้สร้าง data.json ทุกประการ
โดยคำนวณ Isolation Forest ซ้ำแล้วเทียบ ml_score ทีละสัญญา — ถ้าไม่ตรง สคริปต์หยุดทันที (exit 1)
เพราะแปลว่า CSV ต้นทางคนละไฟล์ หรือไลบรารีให้ผลต่างไปจากตอนสร้าง data.json

การใช้งาน:
    python tools/build_deep_pattern.py --input <raw_data.csv>              # สร้างไฟล์
    python tools/build_deep_pattern.py --input <raw_data.csv> --check      # ตรวจซ้ำ ไม่เขียนไฟล์
    python tools/build_deep_pattern.py --input <raw_data.csv> --match-only # ทำแค่ขั้นตอนที่ 1 (ตรวจความตรงกัน)

ใช้เพียง numpy / scipy / pandas เหมือน ds_models.py ไม่เพิ่ม dependency (ดู ds_models.py หัวไฟล์)
"""

from __future__ import annotations

# ต้องตั้งก่อน import โมดูลอื่นในโปรเจกต์ — tools/__pycache__/*.pyc ถูก commit ไว้ใน git
# ถ้าปล่อยให้ python คอมไพล์ใหม่จะกลายเป็นไฟล์ที่เปลี่ยนแปลงอยู่นอกเหนือความตั้งใจ
import sys
sys.dont_write_bytecode = True

import argparse
import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np
import pandas as pd

# คอนโซล Windows บางเครื่องเป็น cp1252 ซึ่งพิมพ์ข้อความไทยจาก build_data.load_records() ไม่ได้
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_data as bd  # noqa: E402
import ds_models as dm  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA_JSON = ROOT / "data" / "data.json"
OUT_JSON = ROOT / "data" / "deep_pattern.json"


# ---------------------------------------------------------------------------
# คีย์ระเบียนแบบเดียวกับ cartKey ของ JS (app.js:7249)
#   cartKey = r => [project_id, contract_no, winner_tin, contract_price_agree, contract_date].join('|')
# JS แปลง number -> string ด้วย Number.prototype.toString() ซึ่งไม่ใส่ ".0" ต่อท้ายเลขจำนวนเต็ม
# ส่วน Python str(28679000000.0) ได้ "28679000000.0" จึงต้องแปลงเองให้ตรงกัน
# ---------------------------------------------------------------------------

def js_str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        if v.is_integer() and abs(v) < 1e15:
            return str(int(v))
        return repr(v)
    if isinstance(v, int):
        return str(v)
    return str(v)


def cart_key(rec: dict) -> str:
    return "|".join(js_str(rec.get(k)) for k in
                     ("project_id", "contract_no", "winner_tin", "contract_price_agree", "contract_date"))


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# Autoencoder เขียนด้วย numpy ล้วน (เหมือน IsolationForest ใน ds_models.py)
#   สถาปัตยกรรม: 12 -> 8 -> 3 -> 8 -> 12, tanh ในชั้นซ่อน, output เชิงเส้น
#   ฝึกด้วย Adam + early stopping บนชุด inner-validation (แยกจาก fold ที่ถูกกันไว้ทดสอบ)
# ---------------------------------------------------------------------------

class Standardizer:
    """มาตรฐานแบบ mean/std fit เฉพาะ train fold — ไม่ใช้ robust scale เพราะฟีเจอร์หลายตัวมี IQR=0
    (ceiling_gap เป็น 1.0 อยู่ ~99.8% ของข้อมูล, zero_surprise เป็น 0 อยู่ ~92%) ทำให้ MAD หารด้วยศูนย์
    ฟีเจอร์ที่เป็น peer-z (log_value_peer ฯลฯ) ถูกทำ robust z ±10 มาแล้วชั้นหนึ่งใน anomaly_features()"""

    def fit(self, X: np.ndarray) -> "Standardizer":
        self.mean = X.mean(axis=0)
        self.std = X.std(axis=0)
        self.std = np.where(self.std < 1e-9, 1.0, self.std)
        return self

    def transform(self, X: np.ndarray) -> np.ndarray:
        return np.clip((X - self.mean) / self.std, -10, 10)


class Autoencoder:
    """MLP autoencoder สมมาตร ฝึกด้วย backprop มือเขียนเอง (MSE loss, Adam optimizer)"""

    def __init__(self, dims: list[int], seed: int):
        rng = np.random.default_rng(seed)
        self.dims = dims
        self.n_layers = len(dims) - 1
        self.W, self.b = [], []
        for i in range(self.n_layers):
            fan_in, fan_out = dims[i], dims[i + 1]
            limit = math.sqrt(6.0 / (fan_in + fan_out))
            self.W.append(rng.uniform(-limit, limit, size=(fan_in, fan_out)))
            self.b.append(np.zeros(fan_out))

    def forward(self, X: np.ndarray):
        acts = [X]
        a = X
        for i in range(self.n_layers):
            z = a @ self.W[i] + self.b[i]
            a = np.tanh(z) if i < self.n_layers - 1 else z  # ชั้นสุดท้ายเชิงเส้น
            acts.append(a)
        return acts

    def reconstruct(self, X: np.ndarray) -> np.ndarray:
        return self.forward(X)[-1]

    def backward(self, acts: list[np.ndarray], y: np.ndarray):
        n, d = y.shape
        grads_W = [None] * self.n_layers
        grads_b = [None] * self.n_layers
        delta = 2.0 * (acts[-1] - y) / (n * d)  # dL/dz ของชั้นสุดท้าย (เชิงเส้น) — MSE เฉลี่ยทั้งชุดและทุกฟีเจอร์
        for i in range(self.n_layers - 1, -1, -1):
            a_prev = acts[i]
            grads_W[i] = a_prev.T @ delta
            grads_b[i] = delta.sum(axis=0)
            if i > 0:
                da_prev = delta @ self.W[i].T
                delta = da_prev * (1 - acts[i] ** 2)  # อนุพันธ์ tanh ของชั้นก่อนหน้า
        return grads_W, grads_b

    def params(self):
        return self.W + self.b

    def set_params(self, params):
        self.W = [p.copy() for p in params[:self.n_layers]]
        self.b = [p.copy() for p in params[self.n_layers:]]

    def get_params_copy(self):
        return [w.copy() for w in self.W] + [bb.copy() for bb in self.b]


def mse(pred: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean((pred - y) ** 2))


def train_autoencoder(X_train: np.ndarray, X_val: np.ndarray, *, dims, seed,
                       lr=5e-3, batch_size=64, max_epochs=3000, patience=60):
    """คืน (model ที่ดีที่สุดบน X_val, best_val_loss, best_epoch, stopped_early)"""
    model = Autoencoder(dims, seed=seed)
    rng = np.random.default_rng(seed + 777)
    n_params = len(model.W) + len(model.b)
    m_W = [np.zeros_like(w) for w in model.W]
    v_W = [np.zeros_like(w) for w in model.W]
    m_b = [np.zeros_like(bb) for bb in model.b]
    v_b = [np.zeros_like(bb) for bb in model.b]
    beta1, beta2, eps = 0.9, 0.999, 1e-8
    t = 0

    best_val = math.inf
    best_params = model.get_params_copy()
    best_epoch = -1
    bad_epochs = 0
    n = X_train.shape[0]

    for epoch in range(max_epochs):
        order = rng.permutation(n)
        for start in range(0, n, batch_size):
            idx = order[start:start + batch_size]
            xb = X_train[idx]
            acts = model.forward(xb)
            gW, gb = model.backward(acts, xb)
            t += 1
            for i in range(model.n_layers):
                m_W[i] = beta1 * m_W[i] + (1 - beta1) * gW[i]
                v_W[i] = beta2 * v_W[i] + (1 - beta2) * (gW[i] ** 2)
                mhat = m_W[i] / (1 - beta1 ** t)
                vhat = v_W[i] / (1 - beta2 ** t)
                model.W[i] -= lr * mhat / (np.sqrt(vhat) + eps)

                m_b[i] = beta1 * m_b[i] + (1 - beta1) * gb[i]
                v_b[i] = beta2 * v_b[i] + (1 - beta2) * (gb[i] ** 2)
                mhat_b = m_b[i] / (1 - beta1 ** t)
                vhat_b = v_b[i] / (1 - beta2 ** t)
                model.b[i] -= lr * mhat_b / (np.sqrt(vhat_b) + eps)

        val_loss = mse(model.reconstruct(X_val), X_val)
        if val_loss < best_val - 1e-7:
            best_val = val_loss
            best_params = model.get_params_copy()
            best_epoch = epoch
            bad_epochs = 0
        else:
            bad_epochs += 1
            if bad_epochs >= patience:
                break

    model.set_params(best_params)
    stopped_early = (epoch < max_epochs - 1)
    return model, best_val, best_epoch, stopped_early, epoch + 1


def rank_pct(values: np.ndarray) -> np.ndarray:
    """เปอร์เซ็นไทล์แบบเดียวกับ pandas .rank(pct=True) ที่ build_data.py ใช้กับ ml_pct"""
    return pd.Series(values).rank(pct=True).to_numpy()


def top_share_overlap(a: np.ndarray, b: np.ndarray, frac: float) -> float:
    n = len(a)
    k = max(1, int(round(n * frac)))
    top_a = set(np.argsort(-a)[:k])
    top_b = set(np.argsort(-b)[:k])
    return len(top_a & top_b) / k


def spearman(a: np.ndarray, b: np.ndarray) -> float:
    ra, rb = rank_pct(a), rank_pct(b)
    if ra.std() == 0 or rb.std() == 0:
        return float("nan")
    return float(np.corrcoef(ra, rb)[0, 1])


def run_oof_ensemble(X_all: np.ndarray, *, dims, fold_seed: int, seeds_per_fold: int,
                      lr=5e-3, batch_size=64, max_epochs=3000, patience=60, val_frac=0.15,
                      keep_models=False, verbose=True):
    """5-fold out-of-fold: ทุกแถวได้คะแนนจากโมเดลที่ไม่เห็นมันตอนฝึก (ทั้งตอน gradient และตอน early-stop)
    seeds_per_fold ตัวต่อ fold ถูกเฉลี่ยเป็น ensemble คืน per_seed_err (seeds_per_fold, n) ให้ดูความเสถียรได้โดยไม่ต้องฝึกซ้ำ"""
    n = X_all.shape[0]
    rng = np.random.default_rng(fold_seed)
    fold = rng.permutation(n) % 5

    per_seed_err = np.full((seeds_per_fold, n), np.nan)
    per_seed_feat_err = np.full((seeds_per_fold, n, X_all.shape[1]), np.nan)
    fold_meta = []
    ensembles = {}   # fold k -> {"scaler":.., "models": [model,...]}

    for k in range(5):
        test_pos = np.nonzero(fold == k)[0]
        train_pos = np.nonzero(fold != k)[0]
        Xtr_full = X_all[train_pos]
        scaler = Standardizer().fit(Xtr_full)
        Xtr_full_s = scaler.transform(Xtr_full)
        Xte_s = scaler.transform(X_all[test_pos])

        rng2 = np.random.default_rng(5000 + fold_seed * 100 + k)
        idx = rng2.permutation(len(Xtr_full_s))
        n_val = max(1, int(round(val_frac * len(idx))))
        val_idx, tr_idx = idx[:n_val], idx[n_val:]
        Xtr, Xval = Xtr_full_s[tr_idx], Xtr_full_s[val_idx]

        seed_meta = []
        models_this_fold = []
        for s in range(seeds_per_fold):
            seed = 1000 * s + fold_seed * 31 + k
            model, best_val, best_epoch, stopped_early, total_epochs = train_autoencoder(
                Xtr, Xval, dims=dims, seed=seed, lr=lr, batch_size=batch_size,
                max_epochs=max_epochs, patience=patience)
            if not stopped_early:
                print(f"[คำเตือน] fold={k} seed={s}: ฝึกจนครบ {max_epochs} epoch โดยไม่ early-stop "
                      f"— อาจยังไม่ลู่เข้า (best_val={best_val:.5f})", file=sys.stderr)
            recon = model.reconstruct(Xte_s)
            feat_err = (recon - Xte_s) ** 2
            per_seed_err[s, test_pos] = feat_err.mean(axis=1)
            per_seed_feat_err[s, test_pos, :] = feat_err
            seed_meta.append({"seed": seed, "best_epoch": best_epoch, "stopped_early": stopped_early,
                               "total_epochs": total_epochs, "best_val": round(best_val, 5)})
            if keep_models:
                models_this_fold.append(model)

        fold_meta.append({"k": k, "n_train": len(tr_idx), "n_inner_val": len(val_idx),
                           "n_test": len(test_pos), "seeds": seed_meta})
        if keep_models:
            ensembles[k] = {"scaler": scaler, "models": models_this_fold}
        if verbose:
            best_es = [m["best_epoch"] for m in seed_meta]
            print(f"    fold {k}: train={len(tr_idx)} val={len(val_idx)} test={len(test_pos)} "
                  f"best_epoch={best_es}")

    oof_err = np.nanmean(per_seed_err, axis=0)
    oof_feat_err = np.nanmean(per_seed_feat_err, axis=0)
    return {
        "fold": fold, "oof_err": oof_err, "oof_feat_err": oof_feat_err,
        "per_seed_err": per_seed_err, "fold_meta": fold_meta, "ensembles": ensembles,
    }


def run_pca_oof(X_all: np.ndarray, *, fold_seed: int, n_components=3) -> np.ndarray:
    """baseline เชิงเส้น: PCA n_components มิติ ใช้ fold เดียวกับ AE (fold_seed) เพื่อเทียบกันตรง ๆ
    ถ้า AE ให้อันดับใกล้ PCA มาก แปลว่าความไม่เป็นเส้นตรงของ AE ไม่ได้ช่วยอะไรเพิ่ม"""
    n = X_all.shape[0]
    rng = np.random.default_rng(fold_seed)
    fold = rng.permutation(n) % 5
    err = np.full(n, np.nan)
    for k in range(5):
        test_pos = np.nonzero(fold == k)[0]
        train_pos = np.nonzero(fold != k)[0]
        scaler = Standardizer().fit(X_all[train_pos])
        Xtr_s = scaler.transform(X_all[train_pos])
        Xte_s = scaler.transform(X_all[test_pos])
        mean = Xtr_s.mean(axis=0)
        U, S, Vt = np.linalg.svd(Xtr_s - mean, full_matrices=False)
        comps = Vt[:n_components]                       # (n_components, d)
        proj = (Xte_s - mean) @ comps.T                  # (n_test, n_components)
        recon = proj @ comps + mean
        err[test_pos] = np.mean((recon - Xte_s) ** 2, axis=1)
    return err


def explain_deep(feats_usable: pd.DataFrame, groups_usable: pd.Series, X_all: np.ndarray,
                  fold: np.ndarray, ensembles: dict, oof_err: np.ndarray, feature_keys: list[str],
                  top_k=400, delta_min=0.005):
    """ปัจจัยที่ทำให้แต่ละสัญญาผิดปกติ ด้วยการแทนค่า (occlusion) — เหมือน E2 ของ Isolation Forest
    (ds_models.py:explain_anomalies) แต่แทนที่ model.score() ด้วย reconstruction error ของ ensemble
    ของ fold นั้น (โมเดลชุดเดียวกับที่ให้คะแนน OOF แถวนี้จริง ไม่ใช่โมเดลที่เคยเห็นแถวนี้)"""
    order = np.argsort(-oof_err)[:top_k]
    med = feats_usable.groupby(groups_usable).median()
    raw = feats_usable.to_numpy()
    out = {}
    for row in order:
        k = int(fold[row])
        grp = groups_usable.iloc[row]
        if grp not in med.index:
            continue
        peer_vals = med.loc[grp].to_numpy()
        raw_row = raw[row]
        ens = ensembles[k]
        scaler = ens["scaler"]
        deltas = np.zeros(len(feature_keys))
        for model in ens["models"]:
            variants = np.tile(raw_row, (len(feature_keys) + 1, 1))
            for j in range(len(feature_keys)):
                variants[j + 1, j] = peer_vals[j]
            variants_s = scaler.transform(variants)
            recon = model.reconstruct(variants_s)
            errs = np.mean((recon - variants_s) ** 2, axis=1)
            base_e, occ_e = errs[0], errs[1:]
            deltas += (base_e - occ_e)
        deltas /= len(ens["models"])
        top_j = np.argsort(-deltas)[:3]
        entries = [[int(j), round(float(deltas[j]), 4), round(float(raw_row[j]), 3), round(float(peer_vals[j]), 3)]
                   for j in top_j if deltas[j] > delta_min]
        if entries:
            out[int(row)] = entries
    return out


# ---------------------------------------------------------------------------
# ขั้นที่ 1: โหลด + ตรวจความตรงกันกับ data.json (ต้องผ่านก่อนฝึกโมเดลเสมอ)
# ---------------------------------------------------------------------------

def load_and_verify(input_csv: Path, data_json: Path, *, verbose=True):
    if not data_json.exists():
        print(f"ไม่พบ {data_json}", file=sys.stderr)
        sys.exit(1)
    sha_before = sha256_of(data_json)
    with open(data_json, encoding="utf-8") as f:
        payload = json.load(f)
    json_records = payload["records"]
    json_meta = payload["meta"]

    if verbose:
        print(f"== ขั้นที่ 1: โหลด {input_csv.name} และตรวจความตรงกับ {data_json.name} ==")
    df = bd.load_records(input_csv)
    bd.attach_demo_fields(df)

    # 1a) จำนวนแถวต้องตรง
    if len(df) != len(json_records):
        print(f"[ไม่ตรง] จำนวนแถว: CSV ให้ {len(df)} แถว แต่ data.json มี {len(json_records)} ระเบียน", file=sys.stderr)
        print("  แปลว่า --input ไม่ใช่ raw_data.csv ไฟล์เดียวกับที่ใช้สร้าง data.json ปัจจุบัน", file=sys.stderr)
        sys.exit(1)

    # 1b) คีย์ต้องตรงทุกแถวตามลำดับเดียวกับ df.index / records ใน data.json
    my_records = bd.build_records(df)
    mismatches = []
    for i, (mine, theirs) in enumerate(zip(my_records, json_records)):
        k1, k2 = cart_key(mine), cart_key(theirs)
        if k1 != k2:
            mismatches.append((i, k1, k2))
    if mismatches:
        print(f"[ไม่ตรง] คีย์ระเบียนต่างกัน {len(mismatches)} จาก {len(json_records)} แถว", file=sys.stderr)
        for i, k1, k2 in mismatches[:5]:
            print(f"  แถว {i}: CSV={k1!r}  data.json={k2!r}", file=sys.stderr)
        sys.exit(1)
    if verbose:
        print(f"  คีย์ระเบียนตรงกันครบ {len(json_records)}/{len(json_records)}")

    # 1c) คำนวณ Isolation Forest ซ้ำ ต้องได้ ml_score เท่ากับใน data.json ทุกแถว (rounded 4 ตำแหน่งเหมือนกัน)
    groups, group_meta = dm.work_group(df)
    disc, agencies, hurdle_meta = dm.hurdle_model(df, groups)
    usable = dm.usable_for_anomaly(df)
    feats = dm.anomaly_features(df, groups, disc["disc_p_zero"])
    score_u, if_meta = dm.isolation_forest(feats[usable])

    json_ml = np.array([r.get("ml_score") for r in json_records], dtype=float)
    my_ml = np.full(len(df), np.nan)
    my_ml[score_u.index.to_numpy()] = score_u.to_numpy()

    both_nan = np.isnan(json_ml) & np.isnan(my_ml)
    diff = np.abs(json_ml - my_ml)
    diff[both_nan] = 0.0
    bad = np.nonzero((diff > 1e-9) & ~both_nan)[0]
    nan_mismatch = np.nonzero(np.isnan(json_ml) != np.isnan(my_ml))[0]
    if len(bad) or len(nan_mismatch):
        print(f"[ไม่ตรง] Isolation Forest ให้ ml_score ต่างจาก data.json ที่ {len(bad)} แถว "
              f"และรูปแบบ NaN ต่างกันที่ {len(nan_mismatch)} แถว", file=sys.stderr)
        print("  แปลว่าฟีเจอร์หรือไลบรารีที่ใช้ตอนนี้ไม่เหมือนตอนสร้าง data.json — หยุดก่อนฝึก Autoencoder", file=sys.stderr)
        sys.exit(1)
    max_abs_diff = float(np.nanmax(diff)) if len(diff) else 0.0
    if verbose:
        print(f"  Isolation Forest คำนวณซ้ำได้ตรงทุกแถว (n={int(usable.sum())}, ผลต่างสูงสุด={max_abs_diff:.6f})")
        print(f"  stability เดิมใน data.json: spearman={if_meta['stability_spearman']} "
              f"top200_overlap={if_meta['stability_top200_overlap']} (ตัวเลขนี้ไม่ถูกใช้ต่อ แค่ยืนยันว่าเป็นชุดเดียวกัน)")

    sha_after = sha256_of(data_json)
    if sha_before != sha_after:
        print("[อันตราย] data.json ถูกแก้ระหว่างสคริปต์ทำงาน — ยกเลิก", file=sys.stderr)
        sys.exit(1)

    return {
        "df": df, "groups": groups, "disc": disc, "usable": usable, "feats": feats,
        "json_records": json_records, "json_meta": json_meta,
        "if_score_u": score_u, "if_meta": if_meta,
        "if_max_abs_diff": max_abs_diff, "data_sha256": sha_after,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", type=Path, required=True, help="raw_data.csv ต้นทาง (ไฟล์เดียวกับที่ใช้สร้าง data.json)")
    ap.add_argument("--data", type=Path, default=DATA_JSON, help="data.json ที่มีอยู่ (ค่าเริ่มต้น: data/data.json)")
    ap.add_argument("--out", type=Path, default=OUT_JSON, help="ไฟล์ปลายทาง (ค่าเริ่มต้น: data/deep_pattern.json)")
    ap.add_argument("--match-only", action="store_true", help="ทำแค่ขั้นที่ 1 (ตรวจความตรงกัน) แล้วจบ ไม่ฝึกโมเดล")
    ap.add_argument("--check", action="store_true", help="คำนวณทั้งหมดใหม่แล้วเทียบกับ --out ที่มีอยู่ ไม่เขียนทับ")
    args = ap.parse_args()

    if not args.input.exists():
        print(f"ไม่พบไฟล์ {args.input}", file=sys.stderr)
        return 1

    t0 = time.time()
    ctx = load_and_verify(args.input, args.data)
    print(f"  ผ่านขั้นที่ 1 ({time.time() - t0:.1f}s)")

    if args.match_only:
        print("--match-only: จบการทำงานตามที่ขอ (ยังไม่ฝึก Autoencoder)")
        return 0

    feats_all = ctx["feats"]
    usable = ctx["usable"]
    groups = ctx["groups"]
    feature_keys = [k for k, _ in dm.FEATURES]

    feats_usable = feats_all[usable]                      # index = ตำแหน่งจริงใน records (0-based, ตรงกับ data.json)
    groups_usable = groups[usable]
    positions = feats_usable.index.to_numpy()             # เอาไว้ map row (0..1080) กลับเป็น i ใน records
    X_all = feats_usable.to_numpy()
    n = X_all.shape[0]
    print(f"== ขั้นที่ 2: ฝึก Autoencoder (n={n}, features={X_all.shape[1]}) ==")

    dims = [12, 8, 3, 8, 12]
    assert X_all.shape[1] == dims[0] == dims[-1]

    print("  -- ensemble หลัก: 5 fold x 5 seed --")
    t1 = time.time()
    main_run = run_oof_ensemble(X_all, dims=dims, fold_seed=0, seeds_per_fold=5, keep_models=True)
    print(f"     เสร็จใน {time.time() - t1:.1f}s")
    oof_err = main_run["oof_err"]
    assert np.all(np.isfinite(oof_err)), "มีแถวที่ไม่ได้รับ OOF error — ตรวจการแบ่ง fold"
    assert np.all(np.isfinite(X_all)), "มีค่า inf/NaN ในฟีเจอร์ก่อนฝึก"

    print("  -- เทียบเสถียรภาพ: fold แบบอื่น (1 seed/fold) --")
    t2 = time.time()
    alt_run = run_oof_ensemble(X_all, dims=dims, fold_seed=1, seeds_per_fold=1, keep_models=False, verbose=False)
    print(f"     เสร็จใน {time.time() - t2:.1f}s")

    print("  -- PCA baseline (3 มิติ, fold เดียวกับ ensemble หลัก) --")
    pca_err = run_pca_oof(X_all, fold_seed=0, n_components=3)

    single_seed_err = main_run["per_seed_err"][0]

    deep_score = np.round(rank_pct(oof_err) * 100, 1)
    oof_err_r = np.round(oof_err, 4)

    stab_alt = {"spearman": round(spearman(oof_err, alt_run["oof_err"]), 3),
                "top5pct_overlap": round(top_share_overlap(oof_err, alt_run["oof_err"], 0.05), 3)}
    stab_seed = {"spearman": round(spearman(oof_err, single_seed_err), 3),
                 "top5pct_overlap": round(top_share_overlap(oof_err, single_seed_err, 0.05), 3)}
    vs_pca = {"spearman": round(spearman(oof_err, pca_err), 3),
              "top5pct_overlap": round(top_share_overlap(oof_err, pca_err, 0.05), 3)}
    if_score = ctx["if_score_u"].to_numpy()
    vs_if = {"spearman": round(spearman(oof_err, if_score), 3),
             "top5pct_overlap": round(top_share_overlap(oof_err, if_score, 0.05), 3),
             "top1pct_overlap": round(top_share_overlap(oof_err, if_score, 0.01), 3),
             "if_reproduced": {"n": int(usable.sum()), "max_abs_diff": ctx["if_max_abs_diff"]}}

    # เกณฑ์ตัดสินประกาศล่วงหน้า (ตกลงกับผู้ใช้ก่อนดูผล)
    verdict_rules = {
        "duplicates_if": "spearman>=0.9 and top5pct_overlap>=0.8",
        "mostly_linear": "vs_pca.spearman>=0.9 and vs_pca.top5pct_overlap>=0.8",
        "stable": "stability(alt_fold).spearman>=0.9 and top5pct_overlap>=0.7",
    }
    verdict = {
        "duplicates_if": bool(vs_if["spearman"] >= 0.9 and vs_if["top5pct_overlap"] >= 0.8),
        "mostly_linear": bool(vs_pca["spearman"] >= 0.9 and vs_pca["top5pct_overlap"] >= 0.8),
        "stable": bool(stab_alt["spearman"] >= 0.9 and stab_alt["top5pct_overlap"] >= 0.7),
        "rules": verdict_rules,
    }

    print("  -- คำอธิบายรายสัญญา (occlusion, top 400) --")
    t3 = time.time()
    why = explain_deep(feats_usable, groups_usable, X_all, main_run["fold"], main_run["ensembles"],
                        oof_err, feature_keys, top_k=min(400, n))
    print(f"     เสร็จใน {time.time() - t3:.1f}s ({len(why)} สัญญามีคำอธิบาย)")

    thresholds = {
        "flag_pct": 95, "strong_pct": 99,
        "err_p50": round(float(np.median(oof_err)), 4),
        "err_p95": round(float(np.quantile(oof_err, 0.95)), 4),
        "err_p99": round(float(np.quantile(oof_err, 0.99)), 4),
        "n_ge95": int((deep_score >= 95).sum()), "n_ge99": int((deep_score >= 99).sum()),
    }

    log10_err = np.log10(np.clip(oof_err, 1e-6, None))
    edges = np.linspace(log10_err.min(), log10_err.max(), 31)
    counts, _ = np.histogram(log10_err, bins=edges)
    histogram = {"scale": "log10_mse", "edges": [round(float(e), 4) for e in edges],
                 "counts": [int(c) for c in counts]}

    top_feature_counts = {}
    for row in np.nonzero(deep_score >= 95)[0]:
        entries = why.get(int(row))
        if entries:
            key = feature_keys[entries[0][0]]
            top_feature_counts[key] = top_feature_counts.get(key, 0) + 1

    config_str = json.dumps({"dims": dims, "fold_seed": 0, "seeds_per_fold": 5, "lr": 5e-3,
                              "batch_size": 64, "max_epochs": 3000, "patience": 60}, sort_keys=True)
    model_version = "ae1-" + hashlib.sha1((config_str + ctx["data_sha256"]).encode()).hexdigest()[:10]

    meta = {
        "model_version": model_version,
        "trained_at": pd.Timestamp.now().isoformat(timespec="seconds"),
        "data_generated_at": ctx["json_meta"]["generated_at"],
        "data_sha256": ctx["data_sha256"],
        "n_records": len(ctx["json_records"]), "n_scored": int(usable.sum()),
        "n_excluded": int((~usable).sum()),
        "features": [{"key": k, "label": l} for k, l in dm.FEATURES],
        "architecture": {"layers": dims, "hidden_activation": "tanh", "output_activation": "linear",
                         "optimizer": "adam", "lr": 5e-3, "batch_size": 64, "max_epochs": 3000, "patience": 60,
                         "standardize": "mean/std ต่อ train fold (ไม่ใช้ robust: ฟีเจอร์หลายตัว IQR=0)"},
        "training": {"folds": 5, "seeds_per_fold": 5, "val_frac": 0.15,
                     "note": "out-of-fold: ทุกแถวได้คะแนนจากโมเดลที่ไม่เห็นมันตอนฝึกหรือตอน early-stop"},
        "folds": main_run["fold_meta"],
        "thresholds": thresholds,
        "stability": {"vs_alt_fold_split": stab_alt, "single_seed_vs_5seed_ensemble": stab_seed},
        "baseline_pca": {"n_components": 3, **vs_pca},
        "vs_isolation_forest": vs_if,
        "verdict": verdict,
        "histogram": histogram,
        "top_feature_counts_top5pct": top_feature_counts,
        "runtime_sec": round(time.time() - t0, 1),
        "versions": {"python": sys.version.split()[0], "numpy": np.__version__, "pandas": pd.__version__},
    }

    rows_out = []
    json_records = ctx["json_records"]
    for row in range(n):
        i = int(positions[row])
        entry = [i, cart_key(json_records[i]), float(deep_score[row]), float(oof_err_r[row])]
        if row in why:
            entry.append(why[row])
        rows_out.append(entry)

    payload_out = {"schema": "deep_pattern/1", "meta": meta,
                   "fields": ["i", "k", "s", "e", "f"], "rows": rows_out}

    # --- ยืนยันความปลอดภัยของค่าก่อนเขียนไฟล์ ---
    assert 0 <= float(np.min(deep_score)) and float(np.max(deep_score)) <= 100
    assert all(len(r) in (4, 5) for r in rows_out)
    keys_out = [r[1] for r in rows_out]
    assert len(keys_out) == len(set(keys_out)), "คีย์ระเบียนซ้ำกันในผลลัพธ์"

    if args.check:
        if not args.out.exists():
            print(f"[--check] ไม่พบ {args.out} ให้เปรียบเทียบ", file=sys.stderr)
            return 1
        with open(args.out, encoding="utf-8") as f:
            old = json.load(f)
        # เทียบเฉพาะคะแนน (การฝึกมีสุ่มบางจุด แต่ seed คงที่ทุกจุดจึงควรตรงเป๊ะ)
        old_by_key = {r[1]: r for r in old["rows"]}
        diffs = 0
        for r in rows_out:
            o = old_by_key.get(r[1])
            if o is None or abs(o[2] - r[2]) > 1e-6 or abs(o[3] - r[3]) > 1e-6:
                diffs += 1
        if diffs:
            print(f"[--check] คะแนนต่างจากไฟล์เดิม {diffs} แถว", file=sys.stderr)
            return 1
        print(f"[--check] ตรงกับ {args.out} ทุกแถว ({len(rows_out)} แถว) — ไม่เขียนทับ")
        return 0

    out_bytes = json.dumps(payload_out, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    tmp = args.out.with_suffix(args.out.suffix + ".tmp")
    tmp.write_bytes(out_bytes)
    tmp.replace(args.out)
    print(f"เขียน {args.out} แล้ว ({len(out_bytes) / 1024:.1f} KB)")

    sha_final = sha256_of(args.data)
    if sha_final != ctx["data_sha256"]:
        print(f"[อันตราย] {args.data} ถูกแก้ระหว่างสคริปต์ทำงาน!", file=sys.stderr)
        return 1
    print(f"ยืนยัน {args.data} ไม่เปลี่ยนแปลง (sha256 {sha_final[:12]}...)")

    print()
    print("== สรุปผล (verdict) ==")
    print(f"  ซ้ำกับ Isolation Forest: {verdict['duplicates_if']}  "
          f"(spearman={vs_if['spearman']}, top5%overlap={vs_if['top5pct_overlap']})")
    print(f"  ส่วนใหญ่เป็นเส้นตรง (≈PCA): {verdict['mostly_linear']}  "
          f"(spearman={vs_pca['spearman']}, top5%overlap={vs_pca['top5pct_overlap']})")
    print(f"  เสถียรข้ามการแบ่ง fold: {verdict['stable']}  "
          f"(spearman={stab_alt['spearman']}, top5%overlap={stab_alt['top5pct_overlap']})")
    print(f"  เสถียรข้าม seed เดี่ยว vs ensemble: spearman={stab_seed['spearman']}, "
          f"top5%overlap={stab_seed['top5pct_overlap']}")
    print(f"  จำนวนที่ deep_score >= 95: {thresholds['n_ge95']} · >= 99: {thresholds['n_ge99']}")
    print(f"  เวลารวม: {meta['runtime_sec']}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
