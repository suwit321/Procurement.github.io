#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_data.py — ETL สำหรับ Procurement Analytics dashboard

อ่าน raw_data.csv -> ทำความสะอาด -> คำนวณ network metrics -> เขียน data/data.json

เหตุผลที่ต้องมีไฟล์นี้:
  data.json เดิมถูกสร้างโดยสคริปต์ที่หายไปจากโปรเจกต์ และสคริปต์นั้น parse ผิด 3 จุด
  (ตัวเลขมีคอมมา, วันที่ไทย พ.ศ., WKT) ทำให้ rule 5 ตัวไม่เคยทำงานและแผนที่ไม่มีหมุดเลย
  ไฟล์นี้จึงถูก commit ไว้เพื่อให้ data.json สร้างซ้ำได้และตรวจสอบได้

การใช้งาน:
    python tools/build_data.py            # สร้าง data/data.json
    python tools/build_data.py --verify   # สร้างแล้วตรวจค่าที่คาดหวัง
"""

from __future__ import annotations

import argparse
import json
import math
import random
import re
import sys
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

import networkx as nx
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ds_models  # noqa: E402  โมเดลวิเคราะห์แยกไฟล์ เพราะเป็นงานคนละชนิดกับการทำความสะอาดข้อมูล

ROOT = Path(__file__).resolve().parent.parent
SRC_CSV = ROOT / "raw_data.csv"
OUT_JSON = ROOT / "data" / "data.json"

# ---------------------------------------------------------------------------
# ตัวแปลงที่ ETL เดิมทำพลาด
# ---------------------------------------------------------------------------

THAI_MONTHS = {
    "ม.ค.": 1, "ก.พ.": 2, "มี.ค.": 3, "เม.ย.": 4, "พ.ค.": 5, "มิ.ย.": 6,
    "ก.ค.": 7, "ส.ค.": 8, "ก.ย.": 9, "ต.ค.": 10, "พ.ย.": 11, "ธ.ค.": 12,
}

_NULLISH = {"", "-", "nan", "none", "null", "NaT"}


def parse_money(value) -> float | None:
    """'3,498,760,900.00' -> 3498760900.0

    คอลัมน์ project_money / price_build / sum_price_agree ใช้คอมมาคั่นหลักพัน
    ส่วน contract_price_agree ไม่ใช้ — ETL เดิม float() ตรงๆ จึงได้ null ทั้งคอลัมน์
    """
    if value is None:
        return None
    text = str(value).strip()
    if text.lower() in _NULLISH:
        return None
    text = text.replace(",", "")
    try:
        return float(text)
    except ValueError:
        return None


def parse_thai_date(value) -> date | None:
    """'20 พ.ย. 68' -> date(2025, 11, 20)

    ปีเป็น พ.ศ. 2 หลัก: 68 -> 2568 -> ค.ศ. 2025 (ลบ 543)
    '-' เป็น sentinel ของค่าว่าง (announce_date ว่าง 81% ซึ่งเป็นโครงสร้างของข้อมูล
    ไม่ใช่ข้อมูลเสีย — มีเฉพาะรายการที่ประกาศเชิญชวน/คัดเลือกเท่านั้น)
    """
    if value is None:
        return None
    text = str(value).strip()
    if text.lower() in _NULLISH:
        return None
    # ไฟล์ที่ผู้ใช้เตรียมเองหรือผลจาก API มักเขียนวันที่เป็น ISO — รับไว้ด้วยเพื่อให้ ETL
    # กินไฟล์ชุดเดียวกับที่เบราว์เซอร์อ่านได้ (ฝั่ง JS อยู่ใน js/dataio.js parseThaiDate)
    iso_match = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", text)
    if iso_match:
        year, month, day = (int(g) for g in iso_match.groups())
        if year > 2400:
            year -= 543
        try:
            return date(year, month, day)
        except ValueError:
            return None

    parts = text.split()
    if len(parts) != 3:
        return None
    day_s, month_s, year_s = parts
    month = THAI_MONTHS.get(month_s)
    if month is None:
        return None
    try:
        day = int(day_s)
        yy = int(year_s)
    except ValueError:
        return None
    buddhist_year = 2500 + yy if yy < 100 else yy
    try:
        return date(buddhist_year - 543, month, day)
    except ValueError:
        return None


_COORD_RE = re.compile(r"-?\d+\.?\d*")


def parse_wkt(value) -> tuple[float | None, float | None, str | None]:
    """WKT -> (lat, lon, geom_type)

    POINT ใช้พิกัดตรง; POLYGON/LINESTRING ยุบเป็น centroid
    หมายเหตุ: WKT เรียง lng ก่อน lat
    """
    if value is None:
        return (None, None, None)
    text = str(value).strip()
    if text.lower() in _NULLISH:
        return (None, None, None)

    geom_type = text.split("(", 1)[0].strip().upper() or None
    numbers = [float(n) for n in _COORD_RE.findall(text)]
    if len(numbers) < 2:
        return (None, None, geom_type)

    lngs = numbers[0::2]
    lats = numbers[1::2]
    pair_count = min(len(lngs), len(lats))
    lon = sum(lngs[:pair_count]) / pair_count
    lat = sum(lats[:pair_count]) / pair_count

    # ขอบเขตประเทศไทยแบบหลวมๆ กันพิกัดสลับแกนหรือค่าขยะ
    if not (5.0 <= lat <= 21.0 and 96.0 <= lon <= 106.0):
        return (None, None, geom_type)
    return (round(lat, 6), round(lon, 6), geom_type)


# ---------------------------------------------------------------------------
# การทำให้ชื่อเป็นมาตรฐาน
# ---------------------------------------------------------------------------

LEGAL_FORMS = [
    "บริษัทจำกัด", "บริษัท", "ห้างหุ้นส่วนจำกัด", "ห้างหุ้นส่วนสามัญ",
    "หจก.", "หสม.", "บมจ.", "บจก.", "ร้าน",
]
JV_MARKER = "สัญญากิจการค้าร่วม"


def canonical_name(value) -> tuple[str, bool]:
    """คืน (ชื่อมาตรฐาน, เป็นกิจการค้าร่วมหรือไม่)

    แก้ 2 ปัญหาที่ทำให้เกิด false positive จำนวนมาก:
      1. เว้นวรรคซ้อน — ชื่อเดียวกันถูกนับเป็นคนละราย 827 แถว
         (เป็นเหตุให้พบ 'บริษัทสลับประมูลกับตัวเอง' ใน bid rotation)
      2. prefix นิติบุคคลซ้ำ เช่น 'ห้างหุ้นส่วนจำกัด ห้างหุ้นส่วนจำกัด สิทธิยนต์'
         ซึ่งเป็นต้นเหตุหลักของ TIN mismatch 120 รายการ — เป็น artifact ไม่ใช่ shell company
    """
    if value is None:
        return ("", False)
    name = re.sub(r"\s+", " ", str(value)).strip()
    if not name:
        return ("", False)

    is_jv = JV_MARKER in name
    name = re.sub(r"\(\s*" + JV_MARKER + r"\s*\)", "", name)
    name = re.sub(r"\s+", " ", name).strip()

    # ตัด prefix นิติบุคคลที่ซ้ำกัน โดยดูว่าส่วนที่เหลือยังขึ้นต้นด้วยนิติบุคคลอีกหรือไม่
    changed = True
    while changed:
        changed = False
        for form in LEGAL_FORMS:
            if name.startswith(form + " "):
                remainder = name[len(form) + 1:].strip()
                if any(remainder.startswith(f) for f in LEGAL_FORMS):
                    name = remainder
                    changed = True
                    break

    return (name.strip(), is_jv)


def is_masked_tin(value) -> bool:
    """TIN ที่ถูกปิดบังแบบ '130990115xxxx' (2,205 แถว) ต้องกันออกจากการวิเคราะห์เชิงตัวตน"""
    return "x" in str(value).lower()


# ---------------------------------------------------------------------------
# โหลดและทำความสะอาด
# ---------------------------------------------------------------------------

def load_records(src: Path = SRC_CSV) -> pd.DataFrame:
    # utf-8-sig กิน BOM ที่ Excel และไฟล์ที่แอปส่งออกใส่ไว้ (ใส่เพื่อให้ Excel อ่านภาษาไทยออก)
    df = pd.read_csv(src, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    print(f"  อ่าน {len(df):,} แถว x {len(df.columns)} คอลัมน์")

    # ไฟล์จากแหล่งอื่นอาจไม่มีบางคอลัมน์ เติมเป็นค่าว่างไว้ก่อน เพื่อให้ขั้นต่อไปไม่ KeyError
    required = list(RECORD_COLUMNS) + ["project_money", "price_build", "sum_price_agree",
                                       "contract_price_agree", "announce_date", "contract_date",
                                       "contract_finish_date", "project_location"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        print(f"  คอลัมน์ที่ไม่มีในไฟล์ (เติมเป็นค่าว่าง): {', '.join(missing)}")
        for col in missing:
            df[col] = ""

    for col in ("project_money", "price_build", "sum_price_agree", "contract_price_agree"):
        df[col] = df[col].map(parse_money)

    for col in ("announce_date", "contract_date", "contract_finish_date"):
        df[col] = df[col].map(parse_thai_date)

    geo = df["project_location"].map(parse_wkt)
    df["lat"] = [g[0] for g in geo]
    df["lon"] = [g[1] for g in geo]
    df["geom_type"] = [g[2] for g in geo]

    canon = df["winner_name"].map(canonical_name)
    df["winner_key"] = [c[0] for c in canon]
    df["is_jv"] = [c[1] for c in canon]
    df["tin_is_masked"] = df["winner_tin"].map(is_masked_tin)

    df["dept_key"] = df["dept_name"].map(lambda x: re.sub(r"\s+", " ", str(x)).strip())

    # ระยะเวลาที่คำนวณได้เมื่อ parse วันที่สำเร็จ — ETL เดิมได้ null ทั้งคอลัมน์
    df["duration_days"] = [
        (f - c).days if (c is not None and f is not None) else None
        for c, f in zip(df["contract_date"], df["contract_finish_date"])
    ]
    df["announce_gap_days"] = [
        (c - a).days if (a is not None and c is not None) else None
        for a, c in zip(df["announce_date"], df["contract_date"])
    ]

    return df


# ---------------------------------------------------------------------------
# ข้อมูลสาธิต (แยก namespace ชัดเจนด้วย prefix demo_)
# ---------------------------------------------------------------------------

def attach_demo_fields(df: pd.DataFrame) -> None:
    """สร้างฟิลด์สาธิตแบบ deterministic

    ชุดข้อมูลจริงไม่มีจำนวนผู้เสนอราคาและวันปิดรับซอง จึงต้องสังเคราะห์เพื่อสาธิต R5/R6
    ใช้ seed คงที่เพื่อให้ผลลัพธ์ทำซ้ำได้ และตั้งชื่อฟิลด์ขึ้นต้น demo_ เพื่อไม่ให้ปนกับข้อมูลจริง
    """
    rng = random.Random(20240101)
    df["demo_n_bidders"] = [rng.choices([1, 2, 3, 4, 5, 6], weights=[22, 20, 20, 16, 12, 10])[0]
                            for _ in range(len(df))]
    df["demo_submission_days"] = [rng.choices([3, 5, 7, 10, 14, 21, 30],
                                              weights=[6, 6, 8, 20, 24, 20, 16])[0]
                                  for _ in range(len(df))]


def build_synthetic_demo(df: pd.DataFrame) -> dict:
    """สร้างข้อมูลสาธิต — ชื่อทุกชื่อสมมุติขึ้นเอง ไม่หยิบมาจาก df

    เวอร์ชันก่อนหน้าสุ่มบริษัท 3 รายจาก top-40 ของจริงมาจับคู่กับ "บุคคลสาธิต N"
    ซึ่งมีปัญหาสองข้อ
      ① ความเชื่อมโยงเป็นการสุ่มล้วน ไม่มีรูปแบบให้เรียนรู้ คู่ที่บังเอิญซ้อนกันสองชั้น
         เป็นผลของ seed ไม่ใช่เคสที่ตั้งใจวาง ถ้านำไปทำภาพอธิบายจะสอนสิ่งที่ไม่มีอยู่จริง
      ② ใช้ชื่อบริษัทจริงที่ระบุตัวได้ จับคู่กับกรรมการสมมุติ กลายเป็นการชี้ว่าบริษัทจริง
         มีเจ้าของร่วมกัน ทั้งที่ชุดข้อมูลไม่มีข้อมูลกรรมการเลย และคำ disclaimer ที่บอกว่า
         "ไม่ได้มาจาก raw_data.csv" ก็ไม่จริงตามไปด้วย

    เวอร์ชันนี้วางโครงเรื่องไว้ 3 ระดับ (ซ้อน 3 ชั้น / 2 ชั้น / ชั้นเดียว) ด้วยชื่อสมมุติทั้งหมด
    เพื่อให้หน้าจอมีเรื่องจริงให้เล่า และมี assert กันไม่ให้ชื่อสมมุติชนกับของจริง
    """
    D = " (สาธิต)"

    # ใช้คำย่อ "บจก." แทน "บริษัท ... จำกัด" เพราะรูปเต็มยาว 21 ตัวอักษรเป็นคำประกอบ
    # เหลือชื่อจริงแค่ไม่กี่ตัว พอไปอยู่ในป้ายกำกับกราฟและกล่องในไดอะแกรมจึงถูกตัดทิ้งหมด
    # จนคำว่า (สาธิต) ที่ต้องเห็นเสมอหายไปด้วย
    def co(name):
        return f"บจก. {name}{D}"

    def person(title, name):
        return f"{title} {name}{D}"

    def addr(no, area):
        return f"{no} ถนนสาธิต {area}{D}"

    def sub(n):
        return f"หจก. ช่างสาธิต {n}{D}"

    # ── คลัสเตอร์ที่ตั้งใจวาง ──────────────────────────────────────────
    # level = จำนวนช่องทางที่ใช้ร่วมกัน ซึ่งคือแกนของเรื่องที่ต้องการสอน
    #   3 ชั้น = ต้องขอคำอธิบาย · 2 ชั้น = ควรดูต่อ · 1 ชั้น = เกิดขึ้นเองได้
    C1 = [co("กอไก่"), co("ขอไข่"), co("คอควาย")]
    C2 = [co("งองู"), co("จอจาน")]
    clusters = [
        {
            "id": "C1", "level": 3, "companies": C1,
            "shared": [
                {"kind": "director", "label": person("นาย", "ฉอฉิ่ง")},
                {"kind": "address", "label": addr("99/1", "เขตสาธิตเหนือ")},
                {"kind": "subcontractor", "label": sub(1)},
            ],
            "note": "สามบริษัทยื่นซองแข่งกันในโครงการเดียว แต่ผูกกลับไปที่กรรมการ ที่อยู่ "
                    "และผู้รับเหมาช่วงรายเดียวกันทั้งหมด",
        },
        {
            "id": "C2", "level": 2, "companies": C2,
            "shared": [
                {"kind": "director", "label": person("นาง", "ชอช้าง")},
                {"kind": "subcontractor", "label": sub(2)},
            ],
            "note": "ใช้กรรมการและผู้รับเหมาช่วงร่วมกัน แต่จดทะเบียนคนละที่",
        },
    ]

    # ── เคสชั้นเดียว: เส้นฐานที่บอกว่าการเชื่อมกันหนึ่งช่องทางเป็นเรื่องปกติ ──
    singles = [
        ("director", person("นาย", "ซอโซ่"), [co("ฌอเฌอ"), co("ญอหญิง")]),
        ("director", person("นาง", "ฎอชฎา"), [co("ฏอปฏัก"), co("ฐอฐาน"), co("ฑอมณโฑ")]),
        ("director", person("นาย", "ฒอผู้เฒ่า"), [co("ณอเณร"), co("ดอเด็ก")]),
        ("address", addr("14/7", "เขตสาธิตใต้"), [co("ตอเต่า"), co("ถอถุง")]),
        ("address", addr("206", "เขตสาธิตตะวันออก"), [co("ทอทหาร"), co("ธอธง"), co("นอหนู")]),
        ("address", addr("3/55", "เขตสาธิตตะวันตก"), [co("บอใบไม้"), co("ปอปลา")]),
        ("subcontractor", sub(3), [co("ผอผึ้ง"), co("ฝอฝา")]),
        ("subcontractor", sub(4), [co("พอพาน"), co("ฟอฟัน"), co("ภอสำเภา")]),
        ("subcontractor", sub(5), [co("มอม้า"), co("ยอยักษ์")]),
    ]

    # ── แปลงเป็นรูปแบบเดิม {shared, contractors[]} เพื่อให้ตารางสามใบในหน้าใช้ได้ตามเดิม ──
    links = {"director": [], "address": [], "subcontractor": []}
    for c in clusters:
        for s in c["shared"]:
            links[s["kind"]].append({
                "shared": s["label"], "contractors": list(c["companies"]),
                "cluster": c["id"], "level": c["level"],
            })
    for kind, label, cos in singles:
        links[kind].append({"shared": label, "contractors": list(cos), "cluster": None, "level": 1})

    # ── เรื่องการยื่นซองของคลัสเตอร์ ① ──────────────────────────────────
    # รูปแบบ "ยื่นประกอบ": รายที่ตั้งใจให้ชนะเสนอต่ำกว่าราคากลางเล็กน้อย
    # อีกสองรายเสนอสูงกว่าราคากลาง ทำให้ซองครบตามจำนวนโดยไม่มีการแข่งขันจริง
    bid_story = {
        "project": f"จ้างก่อสร้างระบบระบายน้ำ ถนนสาธิต ระยะที่ 2{D}",
        "price_build": 48_500_000.0,
        "bids": [
            {"company": C1[0], "amount": 48_100_000.0, "is_winner": True},
            {"company": C1[1], "amount": 49_800_000.0, "is_winner": False},
            {"company": C1[2], "amount": 51_200_000.0, "is_winner": False},
        ],
        "note": "ผู้ชนะเสนอต่ำกว่าราคากลาง 0.8% ส่วนอีกสองรายเสนอสูงกว่าราคากลาง "
                "ซองจึงครบสามรายตามระเบียบ โดยที่ราคาไม่ได้ถูกกดลงจากการแข่งขัน",
    }

    # ── กระดานติดตาม: ชื่อโครงการ/หน่วยงาน/ผู้ชนะสมมุติทั้งหมด ──────────
    # ของเดิมแปะสถานะคดีสมมุติลงบนโครงการจริงที่ระบุชื่อได้ ซึ่งเท่ากับสร้างสถานะ
    # การตรวจสอบปลอมให้สัญญาจริง และจำนวนเคสต่อสถานะเท่ากันเป๊ะ 12/12/12/12/12
    # ทำให้กราฟสรุปแบนราบจนไม่มีอะไรให้อ่าน ที่นี่จึงกระจายให้ลดหลั่นตามความเป็นจริง
    statuses = ["รอคัดกรอง", "กำลังตรวจสอบ", "รอเอกสาร", "สรุปผล", "ปิดเคส"]
    per_status = [18, 14, 11, 9, 8]
    works = ["ก่อสร้างระบบประปาหมู่บ้าน", "ปรับปรุงผิวจราจรแอสฟัลต์",
             "ก่อสร้างอาคารเรียน 4 ชั้น", "วางท่อระบายน้ำ", "ก่อสร้างสะพานคอนกรีต",
             "ปรับปรุงระบบไฟฟ้าส่องสว่าง", "ขุดลอกคลองส่งน้ำ", "ก่อสร้างสนามกีฬาชุมชน"]
    depts = [f"หน่วยงานสาธิต {ch}{D}" for ch in ("ก", "ข", "ค", "ง")]
    winners = C1 + C2 + [co("รอเรือ"), co("ลอลิง"), co("วอแหวน")]

    rng = random.Random(20240202)
    cases, n = [], 0
    for si, status in enumerate(statuses):
        for _ in range(per_status[si]):
            n += 1
            # มูลค่าลดหลั่นตามลำดับขั้น เคสใหญ่มักค้างอยู่ต้นสาย
            value = round(rng.uniform(8, 95 - si * 12) * 1_000_000, -4)
            cases.append({
                "case_id": f"DEMO-{n:03d}",
                "project_id": f"DEMO{n:07d}",
                "project_name": f"{works[n % len(works)]} แห่งที่ {n}{D}",
                "dept_name": depts[n % len(depts)],
                "winner_name": winners[n % len(winners)],
                "value": value,
                "status": status,
                "owner": f"ผู้ตรวจสอบสาธิต {(n % 4) + 1}",
            })

    demo = {
        "disclaimer": (
            "ทุกชื่อและทุกตัวเลขในส่วนนี้สมมุติขึ้นเพื่อสาธิตแนวคิด ไม่ได้มาจาก raw_data.csv "
            "และไม่ถูกนับรวมในคะแนนความเสี่ยงจริง"
        ),
        "clusters": clusters,
        "bid_story": bid_story,
        "director_links": links["director"],
        "address_links": links["address"],
        "subcontractor_links": links["subcontractor"],
        "workflow_statuses": statuses,
        "workflow_cases": cases,
        # ช่องว่างของข้อมูล: ฟิลด์ที่ raw_data.csv ไม่มี และสิ่งที่จะตรวจได้ถ้ามี
        # coverage: none = ยังตรวจไม่ได้เลย · proxy = มีตัวแทนสังเคราะห์หรือฟิลด์ใกล้เคียงใช้แทน
        "gaps": [
            {"field": "จำนวนผู้เสนอราคา", "coverage": "proxy", "rule": "R5",
             "unlocks": "ตรวจจับโครงการที่มีผู้ยื่นซองรายเดียว",
             "status": "สังเคราะห์ไว้ที่ฟิลด์ demo_n_bidders กฎ R5 จึงทำงานได้ แต่ไม่ใช่ของจริง"},
            {"field": "วันปิดรับซอง", "coverage": "proxy", "rule": "R6",
             "unlocks": "ตรวจจับระยะเวลายื่นข้อเสนอที่สั้นผิดปกติ",
             "status": "สังเคราะห์ไว้ที่ demo_submission_days · ใช้ R16 ที่คิดจากวันประกาศแทนได้"},
            {"field": "กรรมการ / ผู้ถือหุ้น", "coverage": "none", "rule": None,
             "unlocks": "ตรวจจับบริษัทที่ยื่นซองแข่งกัน แต่มีเจ้าของหรือกรรมการร่วมกัน",
             "status": "ยังตรวจไม่ได้ ต้องเชื่อมข้อมูลนิติบุคคลจากกรมพัฒนาธุรกิจการค้า"},
            {"field": "ที่อยู่จดทะเบียน", "coverage": "none", "rule": None,
             "unlocks": "ตรวจจับหลายบริษัทที่จดทะเบียนอยู่ที่เดียวกัน",
             "status": "ยังตรวจไม่ได้ ต้องเชื่อมข้อมูลนิติบุคคลเช่นกัน"},
            {"field": "ผู้รับเหมาช่วง", "coverage": "none", "rule": None,
             "unlocks": "ตรวจจับกรณีผู้แพ้กลายเป็นผู้รับเหมาช่วงของผู้ชนะ",
             "status": "ยังตรวจไม่ได้ ชุดข้อมูลบันทึกเฉพาะคู่สัญญาหลัก"},
        ],
    }

    assert_demo_names_are_fictional(df, demo)
    return demo


def assert_demo_names_are_fictional(df: pd.DataFrame, demo: dict) -> None:
    """กันไม่ให้ชื่อสมมุติชนกับชื่อจริงในชุดข้อมูล

    ถ้าชนกันเมื่อใด หน้าจอจะกลายเป็นการชี้ว่าองค์กรจริงมีพฤติกรรมตามที่สาธิตไว้
    ซึ่งเป็นข้อกล่าวหาที่ไม่มีหลักฐานรองรับ จึงให้สคริปต์ล้มทันทีแทนที่จะปล่อยผ่าน
    """
    real = set()
    for col in ("winner_key", "winner_name", "dept_key", "dept_name", "project_name"):
        if col in df.columns:
            real.update(str(v) for v in df[col].dropna().unique())

    names = set()
    for key in ("director_links", "address_links", "subcontractor_links"):
        for row in demo[key]:
            names.add(row["shared"])
            names.update(row["contractors"])
    for c in demo["clusters"]:
        names.update(c["companies"])
        names.update(s["label"] for s in c["shared"])
    names.add(demo["bid_story"]["project"])
    names.update(b["company"] for b in demo["bid_story"]["bids"])
    for c in demo["workflow_cases"]:
        names.update((c["project_name"], c["dept_name"], c["winner_name"]))

    clash = sorted(names & real)
    if clash:
        raise SystemExit(f"ชื่อสาธิตชนกับชื่อจริงในชุดข้อมูล: {clash[:5]}")


# ---------------------------------------------------------------------------
# Network metrics
# ---------------------------------------------------------------------------

def percentile_rank(values: list[float]) -> list[float]:
    """แปลงเป็น percentile 0-100

    จำเป็นเพราะของเดิม network_risk อยู่สเกล 0-22 ขณะที่มิติอื่น 0-100
    ทำให้น้ำหนัก 30% ที่ประกาศไว้ใน UI ไม่เป็นความจริง
    """
    n = len(values)
    if n == 0:
        return []
    arr = np.asarray(values, dtype=float)
    if float(np.nanmax(arr) - np.nanmin(arr)) == 0.0:
        return [0.0] * n
    ranks = arr.argsort().argsort().astype(float)
    return [round(r / (n - 1) * 100, 2) if n > 1 else 0.0 for r in ranks]


def build_network(df: pd.DataFrame) -> tuple[list[dict], list[dict]]:
    pair = (
        df.groupby(["dept_key", "winner_key"])
        .agg(value=("contract_price_agree", "sum"), n=("project_id", "size"))
        .reset_index()
    )
    pair = pair[pair["winner_key"].astype(bool) & pair["dept_key"].astype(bool)]

    edges = [
        {"source": r.dept_key, "target": r.winner_key,
         "value": float(r.value or 0), "n": int(r.n)}
        for r in pair.itertuples()
    ]
    print(f"  เส้นเชื่อม {len(edges):,} คู่")

    graph = nx.Graph()
    for e in edges:
        graph.add_node("A::" + e["source"], kind="agency", name=e["source"])
        graph.add_node("C::" + e["target"], kind="contractor", name=e["target"])
        graph.add_edge("A::" + e["source"], "C::" + e["target"],
                       weight=e["value"], n=e["n"])
    print(f"  โหนด {graph.number_of_nodes():,} จุด")

    print("  คำนวณ PageRank ...")
    pagerank = nx.pagerank(graph, weight="weight")

    k = min(400, graph.number_of_nodes())
    print(f"  คำนวณ Betweenness (k={k} pivots) ...")
    betweenness = nx.betweenness_centrality(graph, k=k, seed=42)

    print("  ตรวจหา community (Louvain) ...")
    communities = nx.community.louvain_communities(graph, weight="weight", seed=42)
    community_of = {node: i for i, comm in enumerate(communities) for node in comm}
    print(f"  พบ {len(communities):,} community")

    node_ids = list(graph.nodes())
    degree = [graph.degree(n) for n in node_ids]
    weighted_degree = [graph.degree(n, weight="weight") for n in node_ids]
    pr_vals = [pagerank.get(n, 0.0) for n in node_ids]
    bt_vals = [betweenness.get(n, 0.0) for n in node_ids]

    deg_n = percentile_rank(degree)
    wdeg_n = percentile_rank(weighted_degree)
    pr_n = percentile_rank(pr_vals)
    bt_n = percentile_rank(bt_vals)

    nodes = []
    for i, node_id in enumerate(node_ids):
        # composite = ความกว้างของเครือข่าย + มูลค่าที่ไหลผ่าน + ความเป็นตัวกลาง
        composite = round(0.30 * deg_n[i] + 0.30 * wdeg_n[i]
                          + 0.20 * pr_n[i] + 0.20 * bt_n[i], 2)
        nodes.append({
            "id": node_id,
            "name": graph.nodes[node_id]["name"],
            "type": graph.nodes[node_id]["kind"],
            "degree": degree[i],
            "weighted_degree": round(float(weighted_degree[i]), 2),
            "pagerank": round(pr_vals[i], 8),
            "betweenness": round(bt_vals[i], 8),
            "degree_n": deg_n[i],
            "weighted_degree_n": wdeg_n[i],
            "pagerank_n": pr_n[i],
            "betweenness_n": bt_n[i],
            "community": community_of.get(node_id, -1),
            "composite_risk_norm": composite,
        })

    nodes.sort(key=lambda n: n["composite_risk_norm"], reverse=True)
    edges.sort(key=lambda e: e["value"], reverse=True)
    return edges, nodes


# ---------------------------------------------------------------------------
# ประกอบ payload
# ---------------------------------------------------------------------------

def iso(value) -> str | None:
    return value.isoformat() if isinstance(value, date) else None


def clean_number(value, digits: int = 2):
    """แปลงเป็น float ที่ JSON เขียนได้

    สำคัญ: pandas แปลงคอลัมน์ที่มี None ให้เป็น float64 แล้วเปลี่ยน None เป็น NaN
    ซึ่ง json.dump จะเขียนออกมาเป็นสัญลักษณ์ NaN ที่ JSON.parse ของเบราว์เซอร์อ่านไม่ได้
    """
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(f) or math.isinf(f):
        return None
    return round(f, digits)


def clean_int(value):
    f = clean_number(value)
    return None if f is None else int(f)


RECORD_COLUMNS = [
    "project_id", "project_name", "project_type_name", "dept_name", "dept_key",
    "dept_sub_name", "purchase_method_name", "purchase_method_group_name",
    "province", "district", "subdistrict",
    "winner_tin", "winner_name", "winner_key", "contract_no",
]


def _num_or_none(value, digits: int = 4):
    try:
        x = float(value)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(x) or math.isinf(x) else round(x, digits)


def build_models(df: pd.DataFrame) -> tuple[dict, dict]:
    """คำนวณโมเดลทั้งหมดใน ds_models.py

    คืน (ฟิลด์รายสัญญา, บล็อก models สำหรับ payload)
    ฟิลด์รายสัญญาถูกแนบเข้า records ตอน build_records() ส่วนบล็อก models คือผลระดับชุดข้อมูล
    ที่หน้าเว็บใช้แสดงวิธีคิด ความน่าเชื่อถือของโมเดล และตารางระดับหน่วยงาน
    """
    print("  ขอบเขตชุดข้อมูล")
    scope = ds_models.dataset_scope(df)
    print("  กลุ่มงานจากชื่อโครงการ")
    groups, group_meta = ds_models.work_group(df)
    print("  คุณภาพพิกัด")
    geo_q, geo_meta = ds_models.geo_quality(df)
    print("  ตรวจความใช้ได้ของการทดสอบเลขหลัก (จำลอง 2,000 รอบต่อสาขา)")
    digits = ds_models.digit_test_audit(df)
    print("  ราคาต่อตารางเมตรของงานถนน")
    road, road_meta = ds_models.road_unit_cost(df, groups)
    print("  แบบจำลองส่วนลดสองชั้น")
    disc, agencies, hurdle_meta = ds_models.hurdle_model(df, groups)
    print("  Isolation Forest")
    usable = ds_models.usable_for_anomaly(df)
    feats = ds_models.anomaly_features(df, groups, disc["disc_p_zero"])
    score_u, if_meta = ds_models.isolation_forest(feats[usable])
    why = ds_models.explain_anomalies(if_meta.pop("model"), feats[usable], groups[usable], score_u)
    score = pd.Series(np.nan, index=df.index)
    score[score_u.index] = score_u
    # อันดับเปอร์เซ็นไทล์ อ่านง่ายกว่าคะแนนดิบซึ่งอยู่ในช่วงแคบ 0.35-0.65
    pct = score.rank(pct=True)

    per_record = {}
    for i in df.index:
        rec = {
            "work_group": groups[i],
            "geo_quality": geo_q[i],
            "disc_p_zero": _num_or_none(disc.at[i, "disc_p_zero"]),
            "disc_depth_resid": _num_or_none(disc.at[i, "disc_depth_resid"], 3),
            "ml_score": _num_or_none(score[i]),
            "ml_pct": _num_or_none(pct[i] * 100, 1),
        }
        if road.at[i, "road_z"] is not None and not pd.isna(road.at[i, "road_z"]):
            rec.update({
                "road_area_m2": _num_or_none(road.at[i, "road_area_m2"], 1),
                "road_per_m2": _num_or_none(road.at[i, "road_per_m2"], 0),
                "road_expected_per_m2": _num_or_none(road.at[i, "road_expected_per_m2"], 0),
                "road_z": _num_or_none(road.at[i, "road_z"], 2),
                "road_surface": road.at[i, "road_surface"],
            })
        if i in why and why[i]:
            rec["ml_why"] = why[i]
        per_record[i] = rec

    models = {
        "scope": scope,
        "digits": digits,
        "geo": geo_meta,
        "work_groups": group_meta,
        "road": road_meta,
        "hurdle": {**hurdle_meta, "agencies": agencies},
        "anomaly": {**if_meta, "n_scored": int(usable.sum()), "n_excluded": int((~usable).sum()),
                    "n_explained": len(why)},
    }
    return per_record, models


def build_records(df: pd.DataFrame, extra: dict | None = None) -> list[dict]:
    records = []
    for idx, row in zip(df.index, df.itertuples(index=False)):
        d = row._asdict()
        rec = {col: (d.get(col) or "") for col in RECORD_COLUMNS}
        rec.update({
            "project_money": clean_number(d["project_money"]),
            "price_build": clean_number(d["price_build"]),
            "sum_price_agree": clean_number(d["sum_price_agree"]),
            "contract_price_agree": clean_number(d["contract_price_agree"]),
            "announce_date": iso(d["announce_date"]),
            "contract_date": iso(d["contract_date"]),
            "contract_finish_date": iso(d["contract_finish_date"]),
            "duration_days": clean_int(d["duration_days"]),
            "announce_gap_days": clean_int(d["announce_gap_days"]),
            "lat": clean_number(d["lat"], 6),
            "lon": clean_number(d["lon"], 6),
            "geom_type": d["geom_type"] if isinstance(d["geom_type"], str) else None,
            "tin_is_masked": bool(d["tin_is_masked"]),
            "is_jv": bool(d["is_jv"]),
            "demo_n_bidders": int(d["demo_n_bidders"]),
            "demo_submission_days": int(d["demo_submission_days"]),
        })
        if extra is not None:
            rec.update(extra[idx])
        records.append(rec)
    return records


def build_meta(df: pd.DataFrame, records: list[dict]) -> dict:
    dates = [d for d in df["contract_date"] if d is not None]
    geo_rows = int(df["lat"].notna().sum())
    return {
        "source_file": SRC_CSV.name,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "total_records": len(records),
        "total_contract_value": clean_number(df["contract_price_agree"].sum()),
        "contract_date_min": min(dates).isoformat() if dates else None,
        "contract_date_max": max(dates).isoformat() if dates else None,
        "budget_years": sorted({str(v) for v in df["budget_year"]}),
        "geo_rows": geo_rows,
        "geo_pct": round(geo_rows / len(records) * 100, 1) if records else 0,
        "n_agencies": int(df["dept_key"].nunique()),
        "n_contractors": int(df["winner_key"].nunique()),
        "n_provinces": int(df["province"].nunique()),
        "n_masked_tins": int(df["tin_is_masked"].sum()),
        "provinces": sorted(p for p in df["province"].unique() if p),
        "methods": sorted(m for m in df["purchase_method_name"].unique() if m),
        "project_types": sorted(t for t in df["project_type_name"].unique() if t),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="สร้าง data/data.json จาก raw_data.csv")
    parser.add_argument("--verify", action="store_true", help="ตรวจค่าที่คาดหวังหลังสร้างไฟล์")
    # แท็บนำเข้าข้อมูลในเบราว์เซอร์ส่งออกไฟล์รูปแบบเดียวกับ raw_data.csv ได้
    # แต่ผู้ใช้มักเก็บไว้คนละชื่อ/คนละที่ จึงให้ระบุไฟล์ต้นทางและปลายทางเองได้
    parser.add_argument("--input", type=Path, default=SRC_CSV, help="ไฟล์ CSV ต้นทาง (ค่าเริ่มต้น: raw_data.csv ในโฟลเดอร์โปรเจกต์)")
    parser.add_argument("--out", type=Path, default=OUT_JSON, help="ไฟล์ JSON ปลายทาง (ค่าเริ่มต้น: data/data.json)")
    args = parser.parse_args()

    src, out_json = args.input, args.out
    if not src.exists():
        print(f"ไม่พบไฟล์ต้นทาง: {src}", file=sys.stderr)
        return 1

    print(f"[1/5] อ่านและทำความสะอาด {src.name}")
    df = load_records(src)

    print("[2/5] สร้างฟิลด์สาธิต")
    attach_demo_fields(df)

    print("[3/5] คำนวณ network metrics")
    edges, nodes = build_network(df)

    print("[4/5] คำนวณโมเดลวิเคราะห์")
    per_record, models = build_models(df)

    print("[5/5] ประกอบ payload")
    records = build_records(df, per_record)
    payload = {
        "meta": build_meta(df, records),
        "records": records,
        "network_edges": edges,
        "network_nodes": nodes,
        "synthetic_demo": build_synthetic_demo(df),
        "models": models,
    }

    print(f"      เขียน {out_json}")
    out_json.parent.mkdir(parents=True, exist_ok=True)
    with out_json.open("w", encoding="utf-8") as fh:
        # allow_nan=False ทำให้ค่า NaN/Infinity ทำให้สคริปต์ล้มทันที
        # แทนที่จะเขียน JSON ที่เบราว์เซอร์ parse ไม่ได้ออกไปเงียบๆ
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"), allow_nan=False)

    size_mb = out_json.stat().st_size / 1024 / 1024
    meta = payload["meta"]
    print()
    print(f"  ระเบียน            {meta['total_records']:,}")
    print(f"  มูลค่ารวม          {meta['total_contract_value']:,.2f} บาท")
    print(f"  ช่วงวันทำสัญญา     {meta['contract_date_min']} .. {meta['contract_date_max']}")
    print(f"  แถวที่มีพิกัด       {meta['geo_rows']:,} ({meta['geo_pct']}%)")
    print(f"  หน่วยงาน/ผู้รับจ้าง {meta['n_agencies']:,} / {meta['n_contractors']:,}")
    print(f"  ขนาดไฟล์           {size_mb:.1f} MB")

    if args.verify:
        return verify(df, payload)
    return 0


# ---------------------------------------------------------------------------
# การตรวจสอบ
# ---------------------------------------------------------------------------

def verify(df: pd.DataFrame, payload: dict) -> int:
    print("\n--- ตรวจสอบ ---")
    meta = payload["meta"]
    records = payload["records"]
    failures: list[str] = []

    def check(label, actual, expected, tol=0):
        ok = abs(actual - expected) <= tol if isinstance(expected, (int, float)) else actual == expected
        print(f"  {'ok  ' if ok else 'FAIL'}  {label}: {actual!r} (คาด {expected!r})")
        if not ok:
            failures.append(label)

    check("จำนวนระเบียน", meta["total_records"], 10174)
    check("มูลค่ารวม", meta["total_contract_value"], 28716369657.38, tol=1.0)
    check("project_money ที่ parse ได้",
          sum(1 for r in records if r["project_money"] is not None), 10174)
    check("price_build ที่ parse ได้",
          sum(1 for r in records if r["price_build"] is not None), 10174)
    check("contract_date ที่ parse ได้",
          sum(1 for r in records if r["contract_date"]), 10174)
    check("วันทำสัญญาแรกสุด", meta["contract_date_min"], "2025-10-01")
    check("วันทำสัญญาล่าสุด", meta["contract_date_max"], "2026-07-31")
    check("แถวที่มีพิกัด", meta["geo_rows"], 6728, tol=40)
    check("TIN ที่ถูกปิดบัง", meta["n_masked_tins"], 2205)
    check("จำนวนจังหวัด", meta["n_provinces"], 77)

    # นับ hit ของ rule ที่เคยไม่ทำงาน เพื่อยืนยันว่าปลดล็อกแล้วจริง
    r1 = sum(1 for r in records
             if r["project_money"] and r["contract_price_agree"] is not None
             and (r["project_money"] - r["contract_price_agree"]) / r["project_money"] >= 0.30)
    r2 = sum(1 for r in records
             if r["price_build"] and r["contract_price_agree"] is not None
             and (r["price_build"] - r["contract_price_agree"]) / r["price_build"] >= 0.30)
    r4 = sum(1 for r in records
             if r["project_money"] is not None and r["contract_price_agree"] is not None
             and r["contract_price_agree"] > r["project_money"])
    r11 = sum(1 for r in records if r["duration_days"] is not None and r["duration_days"] < 0)
    r12 = sum(1 for r in records
              if r["contract_price_agree"] is not None
              and 450_000 <= r["contract_price_agree"] < 500_000)
    r13 = sum(1 for r in records
              if r["price_build"] and r["contract_price_agree"] is not None
              and abs(r["contract_price_agree"] / r["price_build"] - 1.0) < 1e-9)
    r14 = sum(1 for r in records
              if r["price_build"] and r["project_money"]
              and abs(r["price_build"] - r["project_money"]) < 1e-9)

    print()
    check("R1 ส่วนลด vs วงเงิน >=30%", r1, 711, tol=5)
    check("R2 ส่วนลด vs ราคากลาง >=30%", r2, 610, tol=5)
    check("R4 สัญญาเกินวงเงิน", r4, 27, tol=2)
    check("R11 วันสิ้นสุดก่อนวันเริ่ม", r11, 10, tol=1)
    check("R12 ราคาชิดเพดาน 500k", r12, 1789, tol=10)
    check("R13 ราคา = ราคากลางพอดี", r13, 3264, tol=20)
    check("R14 ราคากลาง = วงเงิน", r14, 4759, tol=20)

    # โมเดล: ตรวจว่ายังทำงานได้และความน่าเชื่อถือไม่ตกลง ไม่ใช่ตรวจค่าตายตัวทุกหลัก
    m = payload["models"]
    print()
    check("ขอบเขต: ไฟล์เรียงด้วย sum_price_agree", m["scope"]["sort_key"], "sum_price_agree")
    check("ขอบเขต: จำนวนโครงการ", m["scope"]["n_projects"], 10000)
    check("กลุ่มงาน: ครอบคลุม >= 95%", m["work_groups"]["coverage"] >= 0.95, True)
    check("พิกัดใช้ร่วม: จำนวนแถว", m["geo"]["shared_rows"], 1702, tol=50)
    check("ส่วนลด: AUC แบบ cross-validation >= 0.75", m["hurdle"]["auc_cv"] >= 0.75, True)
    check("ถนน: ตัวอย่างที่ระบุขนาด >= 60", m["road"]["n"] >= 60, True)
    check("ถนน: พื้นที่สัมพันธ์กับราคา r >= 0.6", (m["road"]["validation"]["area_corr_price"] or 0) >= 0.6, True)
    check("ถนน: เส้นพิกัดไม่สัมพันธ์กับราคา r < 0.3",
          (m["road"]["validation"]["geometry_corr_price"] or 0) < 0.3, True)
    check("Isolation Forest: ความเสถียรข้าม seed (Spearman) >= 0.95",
          m["anomaly"]["stability_spearman"] >= 0.95, True)
    check("เลขหลัก: เบนฟอร์ดติดธง >= 80% (ยืนยันว่าใช้ไม่ได้)",
          (m["digits"]["tests"][0]["share_p05"] or 0) >= 0.8, True)

    print()
    if failures:
        print(f"ไม่ผ่าน {len(failures)} รายการ: {', '.join(failures)}")
        return 1
    print("ผ่านทั้งหมด")
    return 0


if __name__ == "__main__":
    sys.exit(main())
