# -*- coding: utf-8 -*-
"""
ds_models.py — โมเดลวิเคราะห์ที่คำนวณล่วงหน้าตอนสร้าง data.json

แยกออกจาก build_data.py เพราะเป็นงานคนละชนิด: build_data.py ทำความสะอาดข้อมูล
ส่วนไฟล์นี้ตั้งสมมุติฐานทางสถิติ ซึ่งต้องอธิบายและตรวจสอบได้ทีละข้อ

ใช้เพียง numpy / scipy / pandas ที่โปรเจกต์มีอยู่แล้ว ไม่เพิ่ม dependency
ทุกฟังก์ชันที่มีการสุ่มกำหนด seed ไว้ ผลจึงออกมาเหมือนเดิมทุกครั้งที่สร้างใหม่

สิ่งที่อยู่ในไฟล์นี้
  dataset_scope()      A3  ขอบเขตจริงของชุดข้อมูล (ถูกตัดที่กี่โครงการ เรียงด้วยอะไร)
  digit_test_audit()   A1  ทดสอบว่าการทดสอบเลขหลักใช้กับข้อมูลชุดนี้ได้หรือไม่
  geo_quality()        A2  พิกัดที่น่าจะเป็นพิกัดสำนักงาน ไม่ใช่ที่ตั้งงาน
  work_group()         D1  กลุ่มงานจากชื่อโครงการ
  road_unit_cost()     C1  ราคาต่อตารางเมตรของงานถนน จากขนาดที่ระบุในชื่อโครงการ
  hurdle_model()       B2  แบบจำลองส่วนลดสองชั้น
  isolation_forest()   E1  ความผิดปกติหลายมิติ
  explain_anomalies()  E2  ปัจจัยที่ทำให้แต่ละสัญญาผิดปกติ
"""

from __future__ import annotations

import math
import re

import numpy as np
import pandas as pd
from scipy.optimize import linprog
from scipy.stats import chi2 as chi2_dist

SPECIFIC = "เฉพาะเจาะจง"


# ---------------------------------------------------------------------------
# A3 · ขอบเขตของชุดข้อมูล
# ---------------------------------------------------------------------------

def dataset_scope(df: pd.DataFrame) -> dict:
    """ตรวจจากตัวข้อมูลเอง ไม่เขียนค่าตายตัว ถ้าไฟล์ต้นทางเปลี่ยน ข้อความบนหน้าจอเปลี่ยนตาม

    สิ่งที่ตรวจ
      - ไฟล์เรียงด้วยคอลัมน์เงินใดแบบลดหลั่นสมบูรณ์ (ถ้ามี = ผลการค้นหาที่ถูกตัดตามอันดับ)
      - ค่าต่ำสุดของคอลัมน์นั้น = จุดตัด
      - คำที่ปรากฏในชื่อโครงการทุกแถว = คำค้นที่ใช้ดึงข้อมูล
    """
    sort_key, cutoff = None, None
    for col in ("sum_price_agree", "contract_price_agree", "project_money", "price_build"):
        s = pd.to_numeric(df[col], errors="coerce")
        if s.notna().all() and int((s.diff() > 0).sum()) == 0:
            sort_key, cutoff = col, float(s.min())
            break

    names = df["project_name"].astype(str)
    keyword = None
    for kw in ("ประปา", "น้ำ", "ถนน", "ก่อสร้าง"):
        if names.str.contains(kw, regex=False).mean() >= 0.999:
            keyword = kw
            break

    n_projects = int(df["project_id"].nunique())
    # จำนวนโครงการที่ลงตัวเป็นหลักพัน/หมื่นพอดี มักเป็นเพดานของการส่งออกข้อมูล
    capped = n_projects in (1000, 2000, 5000, 10000, 20000, 50000)

    return {
        "sort_key": sort_key,
        "cutoff_value": cutoff,
        "n_projects": n_projects,
        "n_contracts": int(len(df)),
        "looks_capped": bool(capped and sort_key is not None),
        "name_keyword": keyword,
        "keyword_share": float(names.str.contains(keyword, regex=False).mean()) if keyword else None,
    }


# ---------------------------------------------------------------------------
# A1 · การทดสอบเลขหลักใช้ได้หรือไม่
# ---------------------------------------------------------------------------

BENFORD = np.array([math.log10(1 + 1 / d) for d in range(1, 10)])
ROUND_CATS = ["000", "x00", "xx0", "xxx"]


def _round_cat(values: pd.Series) -> pd.Series:
    iv = np.floor(values).astype(np.int64)
    return pd.Series(np.select([iv % 1000 == 0, iv % 100 == 0, iv % 10 == 0],
                               ROUND_CATS[:3], "xxx"), index=values.index)


def _bh_share(pvals: np.ndarray, q: float = 0.05) -> float:
    """สัดส่วนที่ยังมีนัยสำคัญหลังคุม false discovery rate แบบ Benjamini–Hochberg"""
    if len(pvals) == 0:
        return 0.0
    ps = np.sort(pvals)
    m = len(ps)
    ok = ps <= q * np.arange(1, m + 1) / m
    return float((ok.nonzero()[0].max() + 1) / m) if ok.any() else 0.0


def digit_test_audit(df: pd.DataFrame, seed: int = 0) -> dict:
    """ลองการทดสอบเลขหลักสามแบบ แล้วดูว่าติดธงหน่วยงานกี่เปอร์เซ็นต์

    เหตุผลที่ต้องทำ: การทดสอบที่ติดธงเกือบทุกหน่วยงาน ไม่ได้บอกอะไรเลย
    เพราะแยกหน่วยงานที่ผิดปกติออกจากหน่วยงานปกติไม่ได้ ต้องพิสูจน์ก่อนนำไปใช้จัดลำดับ

      ① เบนฟอร์ดตามทฤษฎี          หน่วยงาน ≥30 สัญญา เทียบ log10(1+1/d)
      ② เทียบกลุ่มเพื่อน             รูปแบบการปัดเศษ เทียบหน่วยงานอื่นในวิธีจัดหา×ประเภท×ช่วงมูลค่าเดียวกัน
      ③ เทียบสาขาพี่น้อง            สาขาเทียบสาขาอื่นในองค์กรเดียวกัน ค่าคาดหวังคุมวิธีจัดหา×ช่วงมูลค่า
                                    และใช้การจำลอง 2,000 รอบแทนสูตร chi-square ที่ไม่แม่นเมื่อ n เล็ก
    """
    rng = np.random.default_rng(seed)
    d = df[pd.to_numeric(df["contract_price_agree"], errors="coerce") >= 1000].copy()
    d["v"] = d["contract_price_agree"].astype(float)
    d["cat"] = _round_cat(d["v"])
    d["band"] = pd.cut(np.log10(d["v"]), [3, 5.3, 5.7, 6.5, 13], labels=False)

    # ช่วงมูลค่าที่กระจุกอยู่ คือเงื่อนไขที่ทำให้เบนฟอร์ดใช้ไม่ได้
    v = d["v"]
    lo, hi = v.quantile(0.10), v.quantile(0.90)
    first = v.astype(np.int64).astype(str).str[0].astype(int)
    observed = np.array([(first == k).mean() for k in range(1, 10)])

    # ① ทฤษฎี
    p1 = []
    for _, g in d.groupby("dept_key"):
        if len(g) < 30:
            continue
        fd = g["v"].astype(np.int64).astype(str).str[0].astype(int)
        o = np.array([(fd == k).sum() for k in range(1, 10)])
        e = BENFORD * o.sum()
        p1.append(1 - chi2_dist.cdf(((o - e) ** 2 / e).sum(), 8))

    # ② กลุ่มเพื่อน
    d["peer"] = d["purchase_method_name"] + "|" + d["project_type_name"] + "|" + d["band"].astype(str)
    peer = (d.groupby("peer")["cat"].value_counts(normalize=True)
            .unstack(fill_value=0).reindex(columns=ROUND_CATS, fill_value=0))
    p2 = []
    for _, g in d.groupby("dept_key"):
        if len(g) < 20:
            continue
        e = peer.loc[g["peer"]].to_numpy().sum(axis=0)
        o = g["cat"].value_counts().reindex(ROUND_CATS, fill_value=0).to_numpy()
        m = e >= 1
        stat = (((o - e)[m]) ** 2 / e[m]).sum()
        p2.append(1 - chi2_dist.cdf(stat, max(int(m.sum()) - 1, 1)))

    # ③ สาขาพี่น้อง
    d["cell"] = d["purchase_method_name"] + "|" + d["band"].astype(str)
    p3 = []
    for _, org in d.groupby("dept_key"):
        subs = [s for s, sg in org.groupby("dept_sub_name") if len(sg) >= 15]
        if len(subs) < 5:
            continue
        for s in subs:
            me, sib = org[org["dept_sub_name"] == s], org[org["dept_sub_name"] != s]
            dist = (sib.groupby("cell")["cat"].value_counts(normalize=True)
                    .unstack(fill_value=0).reindex(columns=ROUND_CATS, fill_value=0))
            cells = me["cell"][me["cell"].isin(dist.index)]
            if len(cells) < 15:
                continue
            P = dist.loc[cells].to_numpy()
            exp = P.mean(axis=0)
            obs = (me.loc[cells.index, "cat"].value_counts(normalize=True)
                   .reindex(ROUND_CATS, fill_value=0).to_numpy())
            mad = np.abs(obs - exp).mean()
            cum = P.cumsum(axis=1)
            sims = np.empty(2000)
            for b in range(2000):
                draw = (rng.random(len(P))[:, None] > cum).sum(axis=1)
                sims[b] = np.abs(np.bincount(draw, minlength=4) / len(P) - exp).mean()
            p3.append(float((sims >= mad).mean()))

    def summary(ps, unit):
        ps = np.array(ps)
        return {"unit": unit, "tested": int(len(ps)),
                "share_p05": float((ps < 0.05).mean()) if len(ps) else None,
                "share_bh": _bh_share(ps) if len(ps) else None}

    return {
        "value_p10": float(lo), "value_p90": float(hi),
        "decades_p10_p90": float(math.log10(hi / lo)),
        "first_digit_observed": observed.round(4).tolist(),
        "first_digit_benford": BENFORD.round(4).tolist(),
        "rounding_share": d["cat"].value_counts(normalize=True).reindex(ROUND_CATS, fill_value=0).round(4).to_dict(),
        "tests": [
            {"id": "benford", "label": "เบนฟอร์ดตามทฤษฎี", **summary(p1, "หน่วยงาน ≥30 สัญญา")},
            {"id": "peer", "label": "รูปแบบปัดเศษ เทียบกลุ่มเพื่อน", **summary(p2, "หน่วยงาน ≥20 สัญญา")},
            {"id": "sibling", "label": "รูปแบบปัดเศษ เทียบสาขาในองค์กรเดียวกัน", **summary(p3, "สาขา ≥15 สัญญา")},
        ],
    }


# ---------------------------------------------------------------------------
# A2 · คุณภาพของพิกัด
# ---------------------------------------------------------------------------

def geo_quality(df: pd.DataFrame, min_rows: int = 3, min_names: int = 3) -> tuple[pd.Series, dict]:
    """ok / shared / none

    shared = รูปเรขาคณิตเดียวกันทุกตัวอักษร ถูกใช้กับสัญญาอย่างน้อย 3 ฉบับ ที่ชื่องานต่างกันอย่างน้อย 3 ชื่อ
    ในข้อมูลนี้ จุดที่ใช้ร่วมกันแม้เพียง 2 สัญญา ไม่ใช่โครงการเดียวกันเลย (0%)
    จึงเป็นร่องรอยของการปักพิกัดที่ตั้งสำนักงานแทนที่ตั้งงาน เช่น การประปานครหลวง
    118 สัญญา งานซ่อมท่อหลายพื้นที่ ปักอยู่จุดเดียวในนนทบุรี
    """
    loc = df["project_location"].fillna("").astype(str).str.strip()
    has = loc.ne("") & loc.ne("-")
    stats = (df[has].assign(_loc=loc[has])
             .groupby("_loc").agg(n=("project_id", "size"), names=("project_name", "nunique"),
                                  depts=("dept_key", "nunique")))
    shared_locs = stats[(stats["n"] >= min_rows) & (stats["names"] >= min_names)]
    q = pd.Series("none", index=df.index)
    q[has] = "ok"
    q[has & loc.isin(shared_locs.index)] = "shared"

    top = shared_locs.sort_values("n", ascending=False).head(8)
    top_rows = []
    for wkt, row in top.iterrows():
        sub = df[loc == wkt]
        top_rows.append({"dept": sub["dept_key"].mode().iat[0], "province": sub["province"].mode().iat[0],
                         "n": int(row["n"]), "names": int(row["names"]), "depts": int(row["depts"])})
    return q, {
        "shared_points": int(len(shared_locs)),
        "shared_rows": int((q == "shared").sum()),
        "shared_multi_agency_points": int((shared_locs["depts"] > 1).sum()),
        "rule": f"รูปเรขาคณิตเดียวกัน ≥{min_rows} สัญญา และชื่องานต่างกัน ≥{min_names} ชื่อ",
        "top": top_rows,
    }


# ---------------------------------------------------------------------------
# D1 · กลุ่มงาน
# ---------------------------------------------------------------------------

# ลองจัดกลุ่มแบบไม่มีผู้สอน (TF-IDF ตัวอักษร 4-gram + SVD + k-means) ก่อนแล้ว
# กลุ่มที่ได้แยกตาม "สำนวนการเขียนชื่อ" มากกว่าชนิดงาน เช่น "ปรับปรุงระบบประปาหมู่บ้าน"
# แตกเป็นสามกลุ่มตามลำดับคำ ขณะที่ "ซื้อเครื่องผลิตน้ำ" ไปรวมกับ "จ้างเหมาบุคคล"
# สำหรับงานตรวจสอบ กลุ่มต้องอธิบายได้ว่าทำไมสัญญานี้อยู่กลุ่มนี้ จึงใช้พจนานุกรมคำ
# ที่สร้างจากการอ่านกลุ่มเหล่านั้น และวัดความครอบคลุมไว้ใน meta
#
# ลำดับมีความหมาย: กลุ่มที่ระบุชนิดงานได้ชัดตรวจก่อน กลุ่มกว้างอย่าง "ซ่อมแซม/ปรับปรุง" และ "ก่อสร้าง" ตรวจท้ายสุด
# คำว่า "ถนน" เดี่ยว ๆ ไม่นับ เพราะงานวางท่อจำนวนมากระบุที่ตั้งเป็นชื่อถนน
WORK_GROUPS = [
    ("leak", "สำรวจ/ซ่อมท่อแตกรั่ว", r"แตกรั่ว|จุดรั่ว|น้ำสูญเสีย|ซ่อมท่อ"),
    ("staff", "จ้างเหมาบุคคล/แรงงาน",
     r"บุคคลภายนอก|ปฏิบัติงาน|ลูกจ้าง|พนักงาน|แรงงานรายวัน|คนงาน|\d+\s*อัตรา|[๐-๙]+\s*อัตรา|จ้างเหมาบริการบุคคล"),
    ("service", "บริการทั่วไป/ไอที",
     r"รักษาความปลอดภัย|ทำความสะอาด|อินเตอร์เน็ต|อินเทอร์เน็ต|เครือข่าย|VPN|โปรแกรม|ซอฟต์แวร์|ระบบบริหาร|เอกสาร|"
     r"เก็บตัวอย่างน้ำ|ตรวจวิเคราะห์|ห้องปฏิบัติการ|ที่ปรึกษา|ออกแบบ|ควบคุมงาน|ประกันภัย|ประชาสัมพันธ์|พิมพ์|จัดเก็บรายได้|ดูแลสวน|ภูมิทัศน์"),
    ("chemical", "สารเคมี/วัสดุวิทยาศาสตร์",
     r"คลอรีน|สารส้ม|PAC|โพลีอะลูมิเนียม|ปูนขาว|สารเคมี|วัสดุวิทยาศาสตร์|น้ำยา|โซดาไฟ|กรดไฮโดร|ไฮโดรคลอริก"),
    ("meter", "มาตรวัดน้ำ", r"มาตรวัดน้ำ|มิเตอร์"),
    ("road", "ถนน/ผิวจราจร",
     r"(ก่อสร้าง|ปรับปรุง|ซ่อมแซม|ซ่อมสร้าง|บูรณะ)\s*(ผิว)?\s*ถนน|ถนน\s*(คอนกรีต|ลาดยาง|ลูกรัง|หินคลุก|แอสฟัล|คสล|ค\.ส\.ล)|"
     r"ผิวจราจร|ลาดยาง|แอสฟัลท์ติก|แอสฟัลต์ติก|คืนสภาพผิว"),
    ("source", "บ่อบาดาล/แหล่งน้ำดิบ",
     r"บาดาล|ขุดลอก|ขุดสระ|สระน้ำ|สระเก็บน้ำ|ฝาย|อ่างเก็บน้ำ|แหล่งน้ำดิบ|น้ำดิบ"),
    ("tower", "หอถัง/ถังเก็บน้ำ",
     r"หอถัง|หอประปา|ถังสูง|ถังเก็บน้ำ|ถังพักน้ำ|หอสูง|ถังแชมเปญ|ถังเหล็ก|บ่อพักน้ำ|ถังน้ำใส"),
    ("plant", "ระบบผลิต/กรองน้ำ",
     r"ผลิตน้ำ|กรองน้ำ|ถาดเติมอากาศ|ถังกรอง|โรงกรอง|โรงผลิต|ตกตะกอน|น้ำดื่ม|อาร์โอ|สารกรอง|ทรายกรอง|กรวดกรอง"),
    ("energy", "เครื่องสูบ/ไฟฟ้า/โซลาร์เซลล์",
     r"เครื่องสูบ|ปั๊ม|ปั้ม|มอเตอร์|พลังงานแสงอาทิตย์|โซลาร์|โซล่า|ไฟฟ้า|หม้อแปลง|ตู้ควบคุม"),
    ("pipe", "วางท่อ/ขยายเขตประปา",
     r"วางท่อ|ขยายเขต|ท่อส่งน้ำ|ท่อจ่ายน้ำ|ท่อเมน|แนวท่อ|เดินท่อ|เปลี่ยนท่อ|ย้ายท่อ|ระบบท่อ|เส้นท่อ|"
     r"ท่อ\s*(PVC|HDPE|พีวีซี|เหล็ก|พีอี)|เชื่อมต่อระบบ"),
    ("material", "วัสดุ/อุปกรณ์ประปา", r"ซื้อวัสดุ|วัสดุประปา|วัสดุก่อสร้าง|อุปกรณ์ประปา|ครุภัณฑ์|อะไหล่|ซื้อท่อ"),
    ("repair", "ซ่อมแซม/ปรับปรุงระบบประปา", r"ซ่อม|ปรับปรุง|บำรุงรักษา|ฟื้นฟู|ย้าย"),
    ("build", "ก่อสร้างระบบประปา", r"ก่อสร้าง|ติดตั้ง|จัดทำระบบประปา|ระบบประปา"),
]
_WG_COMPILED = [(k, re.compile(rx)) for k, _, rx in WORK_GROUPS]
WORK_GROUP_LABELS = {k: label for k, label, _ in WORK_GROUPS} | {"other": "อื่นๆ"}


def work_group(df: pd.DataFrame) -> tuple[pd.Series, dict]:
    def classify(name: str) -> str:
        for key, rx in _WG_COMPILED:
            if rx.search(name):
                return key
        return "other"

    g = df["project_name"].fillna("").astype(str).map(classify)
    counts = g.value_counts()
    return g, {
        "labels": WORK_GROUP_LABELS,
        "order": [k for k, _, _ in WORK_GROUPS] + ["other"],
        "counts": {k: int(v) for k, v in counts.items()},
        "coverage": float((g != "other").mean()),
        "method": "พจนานุกรมคำจากชื่อโครงการ ตรวจตามลำดับ กลุ่มแรกที่ตรงคือกลุ่มของสัญญา",
    }


# ---------------------------------------------------------------------------
# C1 · ราคาต่อตารางเมตรของงานถนน
# ---------------------------------------------------------------------------

SURFACES = [("rc", "คอนกรีตเสริมเหล็ก", r"คอนกรีตเสริมเหล็ก|ค\.?ส\.?ล|คสล"),
            ("asphalt", "แอสฟัลต์/ลาดยาง", r"แอสฟัล|ลาดยาง"),
            ("gravel", "ลูกรัง/หินคลุก", r"ลูกรัง|หินคลุก")]

COMBINED_SCOPE = r"ท่อระบาย|รางวี|รางระบาย|บ่อพัก|ท่อลอด|ระบายน้ำ"

_NUM = r"(\d+(?:[,\.]\d+)*)"
_RX_WIDTH = re.compile(r"กว้าง\s*(?:เฉลี่ย)?\s*" + _NUM + r"\s*(?:เมตร|ม\.)")
_RX_LENGTH = re.compile(r"ยาว\s*(?:รวม)?\s*" + _NUM + r"\s*(กิโลเมตร|กม\.|เมตร|ม\.)")
_RX_AREA = re.compile(r"(?:พื้นที่|ไม่น้อยกว่า)\s*" + _NUM + r"\s*(?:ตารางเมตร|ตร\.\s*ม)")


def _to_float(text: str) -> float | None:
    try:
        return float(text.replace(",", ""))
    except (ValueError, AttributeError):
        return None


def road_length_m_from_name(name: str) -> float | None:
    m = _RX_LENGTH.search(name)
    if not m:
        return None
    x = _to_float(m.group(1))
    if x is None:
        return None
    return x * 1000 if m.group(2) in ("กิโลเมตร", "กม.") else x


def road_area_from_name(name: str) -> float | None:
    """พื้นที่ผิวทาง (ตร.ม.) จากชื่อโครงการ

    ลำดับ: ระบุพื้นที่ตรง ๆ ก่อน ถ้าไม่มีจึงคูณกว้าง x ยาว
    ชื่อที่ระบุหลายช่วงให้ใช้ค่าแรก ซึ่งมักเป็นช่วงหลักของงาน
    """
    m = _RX_AREA.search(name)
    if m:
        return _to_float(m.group(1))
    w = _RX_WIDTH.search(name)
    length = road_length_m_from_name(name)
    width = _to_float(w.group(1)) if w else None
    if width is None or length is None:
        return None
    return width * length


def _line_km(wkt: str) -> float | None:
    pts = [tuple(map(float, p.split())) for p in re.findall(r"-?[\d\.]+ -?[\d\.]+", wkt)]
    if len(pts) < 2:
        return None
    km = 0.0
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        p1, p2 = math.radians(y1), math.radians(y2)
        a = (math.sin((p2 - p1) / 2) ** 2 +
             math.cos(p1) * math.cos(p2) * math.sin(math.radians(x2 - x1) / 2) ** 2)
        km += 2 * 6371.0 * math.asin(math.sqrt(a))
    return km


def _median_regression(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    """ถดถอยควอนไทล์ที่ 0.5 (least absolute deviation) ด้วย linear programming

    ใช้ค่ามัธยฐานแทนค่าเฉลี่ย เพราะราคาต่อหน่วยมีค่าสุดโต่ง
    ถ้าใช้กำลังสองน้อยที่สุด ค่าสุดโต่งไม่กี่รายการจะดึงเส้นคาดการณ์จนค่าสุดโต่งดูปกติ
    """
    n, p = X.shape
    c = np.concatenate([np.zeros(2 * p), np.ones(2 * n)])
    A = np.hstack([X, -X, np.eye(n), -np.eye(n)])
    res = linprog(c, A_eq=A, b_eq=y, bounds=(0, None), method="highs")
    if not res.success:
        raise RuntimeError("median regression ไม่ลู่เข้า: " + res.message)
    return res.x[:p] - res.x[p:2 * p]


def _corr_log(a, b) -> float | None:
    a, b = np.asarray(a, float), np.asarray(b, float)
    ok = (a > 0) & (b > 0)
    if ok.sum() < 10:
        return None
    return round(float(np.corrcoef(np.log(a[ok]), np.log(b[ok]))[0, 1]), 3)


def road_unit_cost(df: pd.DataFrame, groups: pd.Series) -> tuple[pd.DataFrame, dict]:
    """ราคาต่อตารางเมตรของงานถนน เทียบค่าคาดการณ์ที่คุมชนิดผิวทางและขนาดงาน

    log(บาท/ตร.ม.) = b0 + b1·log(ตร.ม.) + ผิวทาง   (median regression)
    ใส่ขนาดไว้ด้วยเพราะงานเล็กมีต้นทุนคงที่ (ขนย้ายเครื่องจักร เตรียมพื้นที่) ต่อหน่วยสูงกว่าโดยธรรมชาติ
    residual ถูกปรับเป็น robust z ด้วย MAD

    เดิมตั้งใจใช้ความยาวของเส้นพิกัด (LINESTRING) แต่ตรวจแล้วใช้ไม่ได้:
    ความยาวเส้นแทบไม่สัมพันธ์กับราคา และไม่ตรงกับความยาวที่ระบุในชื่อโครงการ
    แสดงว่าเส้นเป็นภาพร่างแนวทาง ไม่ใช่ปริมาณงาน ตัวเลขการตรวจนี้เก็บไว้ใน validation
    """
    road = df[groups.eq("road") & df["project_type_name"].eq("จ้างก่อสร้าง") &
              (df["contract_price_agree"] > 0)].copy()

    # ── ตรวจความใช้ได้ของแหล่งปริมาณงานสองแหล่ง ──
    loc = road["project_location"].fillna("").astype(str)
    line = road[loc.str.upper().str.startswith("LINESTRING")].copy()
    line["km"] = line["project_location"].map(_line_km)
    line = line[(line["km"] > 0.02) & (line["km"] < 50)]
    name_m = road["project_name"].map(road_length_m_from_name)
    both = line.join(name_m.rename("name_m")).dropna(subset=["name_m"])
    both = both[both["name_m"] > 0]
    road["area"] = road["project_name"].map(road_area_from_name)
    validation = {
        "geometry_n": int(len(line)),
        "geometry_corr_price": _corr_log(line["contract_price_agree"], line["km"]),
        "geometry_vs_name_n": int(len(both)),
        "geometry_vs_name_corr": _corr_log(both["km"], both["name_m"]),
        "geometry_vs_name_ratio": (round(float(np.median(both["km"] * 1000 / both["name_m"])), 2)
                                   if len(both) else None),
    }

    cand = road[(road["area"] >= 20) & (road["area"] <= 500000)].copy()
    # งานถนนที่รวมงานระบายน้ำไว้ในสัญญาเดียว ราคาต่อตร.ม. สูงเพราะขอบเขตงานมากกว่า ไม่ใช่เพราะแพง
    # จึงตัดออกจากการเทียบ ไม่เช่นนั้นกลุ่มนี้จะยึดอันดับ "แพงผิดปกติ" ทั้งหมด
    combined = cand["project_name"].str.contains(COMBINED_SCOPE, regex=True)
    validation["area_combined_excluded"] = int(combined.sum())
    cand = cand[~combined]
    validation["area_n"] = int(len(cand))
    validation["area_corr_price"] = _corr_log(cand["contract_price_agree"], cand["area"])

    def surface(name):
        for key, _, rx in SURFACES:
            if re.search(rx, name):
                return key
        return "other"

    cand["surface"] = cand["project_name"].map(surface)
    cand["per_m2"] = cand["contract_price_agree"] / cand["area"]
    cols = ["road_area_m2", "road_per_m2", "road_expected_per_m2", "road_z", "road_surface"]
    out = pd.DataFrame(index=df.index, columns=cols, dtype=object)
    labels = {k: l for k, l, _ in SURFACES} | {"other": "ไม่ระบุผิวทาง"}
    if len(cand) < 30:
        return out, {"n": int(len(cand)), "validation": validation, "surfaces": labels,
                     "note": "งานถนนที่ระบุขนาดในชื่อน้อยเกินกว่าจะสร้างค่าคาดการณ์"}

    counts = cand["surface"].value_counts()
    base_surface = counts.index[0]
    # หมวดที่ใหญ่สุดเป็นฐาน ถ้าใส่ dummy ครบทุกหมวดพร้อมค่าคงที่ ตัวแปรจะ collinear
    # แล้ว LP คืนคำตอบที่แบ่งค่าระหว่างค่าคงที่กับ dummy แบบใดก็ได้
    surf_keys = [k for k in counts.index[1:] if counts[k] >= 5]
    X = np.column_stack([np.ones(len(cand)), np.log(cand["area"].to_numpy())] +
                        [(cand["surface"] == k).to_numpy().astype(float) for k in surf_keys])
    y = np.log(cand["per_m2"].to_numpy())
    beta = _median_regression(X, y)
    resid = y - X @ beta
    mad = float(np.median(np.abs(resid - np.median(resid))) * 1.4826)
    z = resid / mad if mad > 0 else resid * 0

    out.loc[cand.index, "road_area_m2"] = cand["area"].round(1)
    out.loc[cand.index, "road_per_m2"] = cand["per_m2"].round(0)
    out.loc[cand.index, "road_expected_per_m2"] = np.exp(X @ beta).round(0)
    out.loc[cand.index, "road_z"] = np.round(z, 2)
    out.loc[cand.index, "road_surface"] = cand["surface"]

    return out, {
        "n": int(len(cand)),
        "median_per_m2": float(np.median(cand["per_m2"])),
        "p10_per_m2": float(np.quantile(cand["per_m2"], 0.1)),
        "p90_per_m2": float(np.quantile(cand["per_m2"], 0.9)),
        "size_elasticity": round(float(beta[1]), 3),
        "base_surface": labels[base_surface],
        # ผลคูณของราคาต่อตร.ม. เมื่อเทียบผิวทางฐาน ที่ขนาดงานเท่ากัน
        "surface_effect": {labels[k]: round(float(math.exp(beta[2 + i])), 3) for i, k in enumerate(surf_keys)},
        # ราคาคาดการณ์ต่อตร.ม. ที่ขนาดงานมัธยฐาน อ่านง่ายกว่าค่าสัมประสิทธิ์
        "expected_at_median_size": {
            labels[k]: round(float(math.exp(beta[0] + beta[1] * math.log(float(cand["area"].median())) +
                                            (beta[2 + surf_keys.index(k)] if k in surf_keys else 0.0))), 0)
            for k in [base_surface] + surf_keys},
        "median_area_m2": float(cand["area"].median()),
        "surface_counts": {labels[k]: int(v) for k, v in cand["surface"].value_counts().items()},
        "mad_log": round(mad, 3),
        "surfaces": labels,
        "flag_z": 2.5,
        "n_flag_high": int((z >= 2.5).sum()),
        "n_flag_low": int((z <= -2.5).sum()),
        "validation": validation,
    }


# ---------------------------------------------------------------------------
# B2 · แบบจำลองส่วนลดสองชั้น
# ---------------------------------------------------------------------------

def agency_class(name: str) -> str:
    for prefix, label in [("องค์การบริหารส่วนตำบล", "อบต."), ("เทศบาลตำบล", "เทศบาลตำบล"),
                          ("เทศบาลเมือง", "เทศบาลเมือง"), ("เทศบาลนคร", "เทศบาลนคร"),
                          ("องค์การบริหารส่วนจังหวัด", "อบจ."), ("การประปา", "การประปา"),
                          ("กรม", "ราชการส่วนกลาง"), ("กระทรวง", "ราชการส่วนกลาง"),
                          ("สำนักงาน", "ราชการส่วนกลาง"), ("มหาวิทยาลัย", "สถานศึกษา"),
                          ("โรงเรียน", "สถานศึกษา"), ("โรงพยาบาล", "สาธารณสุข")]:
        if str(name).startswith(prefix):
            return label
    return "อื่นๆ"


def _design(df: pd.DataFrame, groups: pd.Series) -> tuple[np.ndarray, list[str]]:
    """ตัวแปรควบคุมของแบบจำลองส่วนลด: สิ่งที่ "อธิบายได้โดยชอบธรรม" ว่าทำไมส่วนลดต่างกัน

    ไม่ใส่หน่วยงานหรือจังหวัดเป็นตัวแปร เพราะส่วนที่ต่างกันระหว่างหน่วยงาน
    คือสิ่งที่ต้องการวัดจาก residual ถ้าใส่เข้าไป โมเดลจะดูดความผิดปกติไปเป็นค่าสัมประสิทธิ์หมด
    """
    cols, names = [np.ones(len(df))], ["intercept"]

    def dummies(series, prefix, min_n=30):
        vc = series.value_counts()
        keep = [k for k in vc.index[1:] if vc[k] >= min_n]     # หมวดใหญ่สุดเป็นฐาน
        for k in keep:
            cols.append((series == k).to_numpy().astype(float))
            names.append(f"{prefix}:{k}")

    dummies(df["purchase_method_name"], "วิธี")
    dummies(groups, "กลุ่มงาน")
    dummies(df["dept_key"].map(agency_class), "ประเภทหน่วยงาน")
    lv = np.log10(df["price_build"].clip(lower=1000).to_numpy())
    # ขนาดงานมีผลไม่เป็นเส้นตรง (เพดาน 5 แสน เปลี่ยนวิธีจัดหา) จึงใช้ช่วงแทนเส้นตรงเส้นเดียว
    for lo, hi in [(5.3, 5.7), (5.7, 6.5), (6.5, 99)]:
        cols.append(((lv >= lo) & (lv < hi)).astype(float))
        names.append(f"ขนาด:{lo}-{hi}")
    return np.column_stack(cols), names


def _logistic_irls(X: np.ndarray, y: np.ndarray, ridge: float = 1.0, iters: int = 50) -> np.ndarray:
    beta = np.zeros(X.shape[1])
    R = ridge * np.eye(X.shape[1])
    R[0, 0] = 0                                    # ไม่ลงโทษค่าคงที่
    for _ in range(iters):
        p = 1 / (1 + np.exp(-np.clip(X @ beta, -30, 30)))
        W = p * (1 - p)
        H = X.T @ (X * W[:, None]) + R
        g = X.T @ (y - p) - R @ beta
        step = np.linalg.solve(H, g)
        beta += step
        if np.abs(step).max() < 1e-8:
            break
    return beta


def _auc(y: np.ndarray, s: np.ndarray) -> float:
    order = np.argsort(s)
    ranks = np.empty(len(s))
    ranks[order] = np.arange(1, len(s) + 1)
    # ค่าเท่ากันได้อันดับเฉลี่ย
    _, inv, counts = np.unique(s, return_inverse=True, return_counts=True)
    ranks = pd.Series(ranks).groupby(inv).transform("mean").to_numpy()
    n1, n0 = y.sum(), len(y) - y.sum()
    return float((ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)) if n1 and n0 else float("nan")


def hurdle_model(df: pd.DataFrame, groups: pd.Series, seed: int = 0) -> tuple[pd.DataFrame, list[dict], dict]:
    """ส่วนลดจากราคากลาง = ชั้นที่ 1 (จะปิดที่ราคากลางพอดีหรือไม่) × ชั้นที่ 2 (ถ้าลด ลดเท่าไร)

    ข้อมูลนี้มีสัญญาที่ส่วนลดเป็นศูนย์พอดี 32% ถ้าจำลองด้วยการถดถอยเส้นเดียว
    จุดมวลที่ศูนย์จะบิดเส้นทั้งเส้น จึงแยกเป็นสองชั้นตามโครงสร้างจริงของข้อมูล

    ผลลัพธ์ระดับหน่วยงาน
      zero_z  = (จำนวนที่ปิดราคาเท่าราคากลางจริง − ที่โมเดลคาด) / ส่วนเบี่ยงเบนมาตรฐานของผลรวม Bernoulli
                บอกว่าหน่วยงานนี้ "ไม่ลดราคาเลย" บ่อยกว่าที่ควรเป็น เมื่อคำนึงถึงวิธีจัดหา กลุ่มงาน ขนาด
      depth_z = ค่าเฉลี่ย residual ของ log(ส่วนลด) หารด้วย standard error
                บอกว่าเมื่อลด ลดน้อยกว่าที่คาดหรือไม่ (ค่าลบ = ลดน้อยกว่าคาด)
    """
    base = df["price_build"].to_numpy(float)
    price = df["contract_price_agree"].to_numpy(float)
    ok = (base > 0) & (price > 0) & (price <= base * 1.5)
    d = df[ok]
    g = groups[ok]
    X, names = _design(d, g)
    ratio = d["contract_price_agree"].to_numpy() / d["price_build"].to_numpy()
    zero = (np.abs(ratio - 1) < 1e-6).astype(float)

    # ชั้นที่ 1 · ประเมินความสามารถแยกแยะด้วย cross-validation 5 ส่วน ไม่ใช่วัดบนข้อมูลที่ใช้สร้างเอง
    rng = np.random.default_rng(seed)
    fold = rng.integers(0, 5, len(zero))
    cv_pred = np.empty(len(zero))
    for k in range(5):
        tr, te = fold != k, fold == k
        b = _logistic_irls(X[tr], zero[tr])
        cv_pred[te] = 1 / (1 + np.exp(-(X[te] @ b)))
    beta1 = _logistic_irls(X, zero)
    p_zero = 1 / (1 + np.exp(-(X @ beta1)))

    # ชั้นที่ 2 · เฉพาะสัญญาที่มีส่วนลดจริง
    pos = (zero == 0) & (ratio < 1)
    ydepth = np.log(1 - ratio[pos])
    Xp = X[pos]
    beta2 = np.linalg.lstsq(Xp.T @ Xp + 1.0 * np.eye(Xp.shape[1]), Xp.T @ ydepth, rcond=None)[0]
    resid2 = np.full(len(zero), np.nan)
    resid2[pos] = ydepth - Xp @ beta2
    sigma2 = float(np.nanstd(resid2[pos]))
    r2 = 1 - np.nanvar(resid2[pos]) / np.var(ydepth)

    per = pd.DataFrame(index=df.index, columns=["disc_p_zero", "disc_depth_resid"])
    per.loc[d.index, "disc_p_zero"] = np.round(p_zero, 4)
    per.loc[d.index, "disc_depth_resid"] = np.round(resid2, 3)

    agg = pd.DataFrame({"dept": d["dept_key"].to_numpy(), "zero": zero, "p": p_zero,
                        "r": resid2, "v": d["contract_price_agree"].to_numpy()})
    agencies = []
    for dept, a in agg.groupby("dept"):
        n = len(a)
        if n < 5:
            continue
        var = (a["p"] * (1 - a["p"])).sum()
        zero_z = (a["zero"].sum() - a["p"].sum()) / math.sqrt(var) if var > 0 else 0.0
        rr = a["r"].dropna()
        depth_z = (rr.mean() / (sigma2 / math.sqrt(len(rr)))) if len(rr) >= 3 else None
        agencies.append({
            "dept": dept, "class": agency_class(dept), "n": int(n),
            "zero_obs": int(a["zero"].sum()), "zero_exp": round(float(a["p"].sum()), 1),
            "zero_z": round(float(zero_z), 2),
            "n_discount": int(len(rr)),
            "depth_z": round(float(depth_z), 2) if depth_z is not None else None,
            "value": float(a["v"].sum()),
        })
    agencies.sort(key=lambda x: -x["zero_z"])

    return per, agencies, {
        "n": int(len(zero)), "zero_share": float(zero.mean()),
        "auc_cv": round(_auc(zero, cv_pred), 3),
        "auc_in_sample": round(_auc(zero, p_zero), 3),
        "depth_r2": round(float(r2), 3), "depth_n": int(pos.sum()),
        "depth_sigma": round(sigma2, 4),
        "coef_zero": {nm: round(float(b), 3) for nm, b in zip(names, beta1)},
        "coef_depth": {nm: round(float(b), 3) for nm, b in zip(names, beta2)},
        "flag_z": 3.0,
    }


# ---------------------------------------------------------------------------
# E1 · Isolation Forest
# ---------------------------------------------------------------------------

def _c(n):
    """ความยาวเส้นทางเฉลี่ยของการค้นหาที่ไม่สำเร็จใน binary search tree ขนาด n (Liu et al. 2008)"""
    n = np.asarray(n, float)
    out = np.zeros_like(n)
    big = n > 2
    out[big] = 2 * (np.log(n[big] - 1) + 0.5772156649) - 2 * (n[big] - 1) / n[big]
    out[n == 2] = 1.0
    return out


class IsolationForest:
    """Isolation Forest เขียนด้วย numpy ล้วน

    หลักการ: ค่าผิดปกติแยกออกจากกลุ่มได้ด้วยการตัดแบ่งแบบสุ่มไม่กี่ครั้ง
    ความลึกเฉลี่ยของใบไม้ที่จุดนั้นตกไปอยู่จึงสั้นกว่าจุดปกติ
    score = 2^(-E[h(x)] / c(ψ))  ใกล้ 1 = ผิดปกติ · ประมาณ 0.5 หรือต่ำกว่า = ปกติ
    """

    def __init__(self, n_trees=300, sample_size=256, seed=0):
        self.n_trees, self.psi, self.seed = n_trees, sample_size, seed
        self.trees = []

    def fit(self, X: np.ndarray):
        rng = np.random.default_rng(self.seed)
        n, p = X.shape
        psi = min(self.psi, n)
        limit = int(math.ceil(math.log2(psi)))
        self.trees = []
        for _ in range(self.n_trees):
            idx = rng.choice(n, psi, replace=False)
            feat, thr, left, right, size = [], [], [], [], []

            def build(rows, depth):
                node = len(feat)
                feat.append(-1); thr.append(0.0); left.append(-1); right.append(-1); size.append(len(rows))
                if depth >= limit or len(rows) <= 1:
                    return node
                sub = X[rows]
                lo, hi = sub.min(axis=0), sub.max(axis=0)
                usable = np.nonzero(hi > lo)[0]
                if len(usable) == 0:
                    return node
                j = rng.choice(usable)
                t = rng.uniform(lo[j], hi[j])
                mask = sub[:, j] < t
                feat[node], thr[node] = int(j), float(t)
                left[node] = build(rows[mask], depth + 1)
                right[node] = build(rows[~mask], depth + 1)
                return node

            build(idx, 0)
            self.trees.append((np.array(feat), np.array(thr), np.array(left), np.array(right), np.array(size)))
        self.c_psi = float(_c([psi])[0])
        return self

    def path_length(self, X: np.ndarray) -> np.ndarray:
        total = np.zeros(len(X))
        for feat, thr, left, right, size in self.trees:
            node = np.zeros(len(X), dtype=int)
            depth = np.zeros(len(X))
            active = np.ones(len(X), dtype=bool)
            while active.any():
                f = feat[node]
                leaf = f < 0
                done = active & leaf
                depth[done] += _c(size[node[done]])
                active &= ~leaf
                if not active.any():
                    break
                ia = np.nonzero(active)[0]
                go_left = X[ia, feat[node[ia]]] < thr[node[ia]]
                node[ia] = np.where(go_left, left[node[ia]], right[node[ia]])
                depth[ia] += 1
            total += depth
        return total / len(self.trees)

    def score(self, X: np.ndarray) -> np.ndarray:
        return 2 ** (-self.path_length(X) / self.c_psi)


# คำอธิบายภาษาไทยของแต่ละ feature — ใช้ทั้งในหน้าจอและในการสร้างประโยคอธิบาย
FEATURES = [
    ("log_value_peer", "มูลค่าเทียบงานกลุ่มเดียวกัน"),
    ("discount", "ส่วนลดจากราคากลาง"),
    ("build_vs_budget", "ราคากลางเทียบวงเงิน"),
    ("log_duration_peer", "ระยะสัญญาเทียบงานกลุ่มเดียวกัน"),
    ("value_per_day_peer", "มูลค่าต่อวันเทียบงานกลุ่มเดียวกัน"),
    ("roundness", "ความกลมของตัวเลขราคา"),
    ("ceiling_gap", "ความชิดเพดาน 500,000 บาท"),
    ("log_pair_count", "จำนวนครั้งที่คู่ค้าเดิมทำสัญญากัน"),
    ("pair_value_share", "สัดส่วนรายได้ผู้รับจ้างจากหน่วยงานนี้"),
    ("log_winner_agencies", "จำนวนหน่วยงานที่ผู้รับจ้างรับงาน"),
    ("log_agency_size", "จำนวนสัญญาของหน่วยงาน"),
    ("zero_surprise", "ความแปลกของการไม่ลดราคาเลย (จากแบบจำลองส่วนลด)"),
]


def _robust_z_by(values: pd.Series, by: pd.Series) -> pd.Series:
    med = values.groupby(by).transform("median")
    mad = (values - med).abs().groupby(by).transform("median") * 1.4826
    glob = (values - values.median()).abs().median() * 1.4826
    mad = mad.where(mad > 1e-9, glob if glob > 0 else 1.0)
    # จำกัดที่ ±10 · ค่าที่เกินนี้ผิดปกติชัดเจนอยู่แล้ว ปล่อยให้เป็น -28 ไม่ได้เพิ่มข้อมูล
    # แต่ทำให้คำอธิบายบนหน้าจออ่านไม่รู้เรื่อง
    return ((values - med) / mad).clip(-10, 10)


def anomaly_features(df: pd.DataFrame, groups: pd.Series, p_zero: pd.Series) -> pd.DataFrame:
    """feature ของแต่ละสัญญา — ไม่ใช้ผลของกฎ R1-R22 เลย เพื่อให้คะแนนนี้เป็นความเห็นอิสระจากชุดกฎ
    และนำไปใช้วัดจุดบอดของชุดกฎได้ (สัญญาที่โมเดลว่าผิดปกติ แต่กฎไม่จับ)
    ค่าที่ขึ้นกับชนิดงานเทียบภายในกลุ่มงาน (D1) ไม่ใช่ทั้งประเทศ งานวางท่อจึงไม่ถูกเทียบกับการซื้อคลอรีน
    """
    v = df["contract_price_agree"].astype(float).clip(lower=1)
    base = df["price_build"].astype(float)
    budget = df["project_money"].astype(float)
    dur = df["duration_days"].astype(float)
    dur = dur.where(dur > 0)
    dur = dur.fillna(dur.groupby(groups).transform("median")).fillna(dur.median())

    f = pd.DataFrame(index=df.index)
    f["log_value_peer"] = _robust_z_by(np.log10(v), groups)
    f["discount"] = (1 - v / base.where(base > 0)).clip(-0.5, 1).fillna(0)
    f["build_vs_budget"] = (base / budget.where(budget > 0)).clip(0, 2).fillna(1)
    f["log_duration_peer"] = _robust_z_by(np.log1p(dur), groups)
    f["value_per_day_peer"] = _robust_z_by(np.log10(v / dur), groups)
    iv = np.floor(v).astype(np.int64)
    f["roundness"] = np.select([iv % 100000 == 0, iv % 10000 == 0, iv % 1000 == 0, iv % 100 == 0], [4, 3, 2, 1], 0)
    f["ceiling_gap"] = np.where(v <= 500000, (500000 - v) / 500000, 1.0)

    pair = df["dept_key"] + "\x1f" + df["winner_key"]
    f["log_pair_count"] = np.log1p(pair.map(pair.value_counts()))
    wval = v.groupby(df["winner_key"]).transform("sum")
    pval = v.groupby(pair).transform("sum")
    f["pair_value_share"] = (pval / wval).fillna(0)
    f["log_winner_agencies"] = np.log1p(df.groupby("winner_key")["dept_key"].transform("nunique"))
    f["log_agency_size"] = np.log1p(df.groupby("dept_key")["project_id"].transform("size"))

    ratio = v / base.where(base > 0)
    is_zero = (ratio - 1).abs() < 1e-6
    pz = p_zero.astype(float).fillna(p_zero.astype(float).median())
    # ไม่ลดราคาเลยทั้งที่โมเดลคาดว่าโอกาสต่ำ = แปลก ; ลดราคาปกติ = ไม่แปลก (ศูนย์)
    f["zero_surprise"] = np.where(is_zero, -np.log(pz.clip(1e-4, 1)), 0.0)

    # TIN ปิดบังทำให้นับหน่วยงานของผู้รับจ้างไม่ได้จริง จึงแทนด้วยค่ามัธยฐานเพื่อไม่ให้ดูผิดปกติเพราะข้อมูลขาด
    masked = df["tin_is_masked"].astype(bool)
    for col in ("log_winner_agencies", "pair_value_share"):
        f.loc[masked, col] = f.loc[~masked, col].median()
    return f[[k for k, _ in FEATURES]].astype(float)


def usable_for_anomaly(df: pd.DataFrame) -> pd.Series:
    """สัญญาที่ราคาเป็น 0 หรือไม่มีราคากลาง เป็นปัญหาคุณภาพข้อมูล ไม่ใช่พฤติกรรมผิดปกติ
    ถ้าปล่อยเข้าโมเดล 8 สัญญาที่ราคา 0 บาทจะยึดอันดับต้นทั้งหมด (ส่วนลด 100%) และบังสิ่งที่ควรเห็น"""
    return (df["contract_price_agree"].astype(float) > 0) & (df["price_build"].astype(float) > 0)


def isolation_forest(features: pd.DataFrame, seed: int = 0) -> tuple[pd.Series, dict]:
    X = features.to_numpy()
    model = IsolationForest(n_trees=300, sample_size=256, seed=seed).fit(X)
    score = model.score(X)

    # ความเสถียร: สร้างป่าใหม่ด้วย seed อื่น ถ้าอันดับเปลี่ยนมาก แปลว่าคะแนนเป็นสัญญาณรบกวน
    alt = IsolationForest(n_trees=300, sample_size=256, seed=seed + 1).fit(X).score(X)
    rho = pd.Series(score).corr(pd.Series(alt), method="spearman")
    top_a = set(np.argsort(-score)[:200])
    top_b = set(np.argsort(-alt)[:200])

    return pd.Series(np.round(score, 4), index=features.index), {
        "model": model,
        "n_trees": 300, "sample_size": 256,
        "stability_spearman": round(float(rho), 3),
        "stability_top200_overlap": round(len(top_a & top_b) / 200, 3),
        "p50": float(np.median(score)), "p95": float(np.quantile(score, 0.95)),
        "p99": float(np.quantile(score, 0.99)),
        "features": [{"key": k, "label": l} for k, l in FEATURES],
    }


def explain_anomalies(model: IsolationForest, features: pd.DataFrame, groups: pd.Series,
                      scores: pd.Series, top_k: int = 400) -> dict:
    """E2 · ปัจจัยที่ทำให้แต่ละสัญญาผิดปกติ ด้วยการแทนค่า (occlusion)

    สำหรับสัญญาที่คะแนนสูงสุด top_k ฉบับ แทน feature ทีละตัวด้วยค่ามัธยฐานของกลุ่มงาน
    แล้ววัดว่าคะแนนลดลงเท่าไร ตัวที่ทำให้ลดลงมากที่สุดคือตัวที่ "ทำให้ผิดปกติ"

    ทำไมไม่ใช่ SHAP: ไลบรารี shap ไม่มีในโปรเจกต์ และ TreeSHAP ของ Isolation Forest
    ต้องเขียนอัลกอริทึมเฉพาะที่ตรวจสอบยาก วิธีแทนค่าอธิบายตรงไปตรงมากว่า
    ("ถ้าค่านี้เป็นค่าปกติของกลุ่ม คะแนนจะเหลือเท่าไร") ข้อจำกัดคือไม่คิดปฏิสัมพันธ์ระหว่าง feature
    """
    order = np.argsort(-scores.to_numpy())[:top_k]
    idx = features.index[order]
    X = features.loc[idx].to_numpy()
    med = features.groupby(groups).median()
    peer = med.reindex(groups.loc[idx]).to_numpy()
    base = scores.loc[idx].to_numpy()
    contrib = np.zeros_like(X)
    for j in range(X.shape[1]):
        Xj = X.copy()
        Xj[:, j] = peer[:, j]
        contrib[:, j] = base - model.score(Xj)
    out = {}
    labels = dict(FEATURES)
    keys = [k for k, _ in FEATURES]
    for row, rid in enumerate(idx):
        c = contrib[row]
        top = np.argsort(-c)[:3]
        out[rid] = [{"key": keys[j], "label": labels[keys[j]], "delta": round(float(c[j]), 4),
                     "value": round(float(X[row, j]), 3), "peer": round(float(peer[row, j]), 3)}
                    for j in top if c[j] > 0.002]
    return out
