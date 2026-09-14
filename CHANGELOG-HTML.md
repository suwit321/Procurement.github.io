# CHANGELOG — ปรับโครงสร้างและงานออกแบบของ index.html

วันที่: 2026-09-07
ขอบเขต: `index.html` และ `css/style.css` เท่านั้น
**ไม่มีการแก้ไขไฟล์ JavaScript ใด ๆ ในงานนี้**

## ไฟล์สำรอง

| ไฟล์ | สำรองไว้ที่ |
|---|---|
| `index.html` | `backup/index.before-ui-redesign.html` |
| `css/style.css` | `backup/style.before-ui-redesign.css` |

---

## 1. ส่วน head

| รายการ | เดิม | ใหม่ |
|---|---|---|
| `<title>` | Procurement Analytics | Procurement Analytics \| ระบบวิเคราะห์ข้อมูลจัดซื้อจัดจ้าง |
| `meta description` | แดชบอร์ดวิเคราะห์ความเสี่ยง... | ระบบวิเคราะห์ข้อมูลจัดซื้อจัดจ้าง ตรวจจับความเสี่ยง และสนับสนุนการตรวจสอบเชิงข้อมูล |
| `theme-color` | `#0f766e` | `#0F766E` |
| CSS query string | `?v=14` | `?v=16` |

คงไว้ครบ: charset, viewport, IBM Plex Sans Thai, Bootstrap 5.3.3, Leaflet 1.9.4,
MarkerCluster, favicon, path ของ `css/style.css`
**ไม่มีการเพิ่ม dependency ใหม่**

> **หมายเหตุเรื่อง theme-color:** ข้อกำหนดระบุให้ใช้ `#1677FF` หรือ `#0F766E`
> เลือก `#0F766E` เพราะสีหลักของระบบ (ปุ่ม แท็บ ป้ายกำกับ กราฟ หมุดแผนที่) เป็นเขียวหัวเป็ดทั้งหมด
> การใช้สีน้ำเงินจะทำให้แถบเบราว์เซอร์ไม่ตรงกับสีในหน้าจริง หากต้องการน้ำเงินให้แก้บรรทัดที่ 7

## 2. Boot screen

- คง `id="bootScreen"`, `id="bootMessage"`, spinner และ `.visually-hidden` เดิม
- เพิ่ม `role="status"`, `aria-live="polite"`, `aria-busy="true"` ที่ตัว `#bootScreen`
- เพิ่ม `aria-hidden="true"` ที่ spinner (เพื่อไม่ให้โปรแกรมอ่านหน้าจออ่านซ้ำกับข้อความ)
- ห่อเนื้อหาด้วย `.boot-panel` และเพิ่มชื่อระบบ `.boot-brand`
- เพิ่ม class `.boot-message` ที่ `#bootMessage` (คง id เดิม)

## 3. Topbar

- เปลี่ยน `<div class="topbar">` เป็น `<header class="topbar" role="banner">` (คง class เดิม)
- เพิ่มตราสัญลักษณ์ตัวอักษร `.brand-mark` (PA) และคำบรรยายระบบ `.brand-sub`
- `#metaLine` คง id และ class เดิม เพิ่ม class `.meta-line` (มีเส้นคั่นด้านซ้าย)
- จัดปุ่มไว้ใน `.topbar-actions`
  - `#provenanceBtn` = การกระทำรอง เพิ่ม class `.btn-neutral`
  - `#exportBtn` = การกระทำหลัก เพิ่ม class `.btn-primary-action` (พื้นทึบสีหลัก)
- ทั้งสองปุ่มคง `type="button"` และ class เดิมครบ เพิ่ม `title` และ `aria-label`

## 4. โครงหลัก

- `<div class="container-fluid ...">` → `<main class="container-fluid ... main-content" id="mainContent">`
  (คง class `container-fluid px-3 px-lg-4 pb-4` เดิมทั้งหมด)
- เพิ่มลิงก์ข้ามไปเนื้อหาหลัก `.skip-link` ก่อน `#bootScreen`
- ห่อ KPI ด้วย `<section aria-labelledby="kpiHeading">`
- ห่อแท็บด้วย `<nav class="tab-nav-wrap" aria-label="มุมมองการวิเคราะห์">`
- เปลี่ยน `<div class="tab-content">` เป็น `<section class="tab-content" aria-label="เนื้อหาการวิเคราะห์">`

## 5. ตัวกรองส่วนกลาง

- คง id ครบทุกตัว: `gfSearch` `gfProvince` `gfMethod` `gfType` `gfBand` `gfRule` `gfMinValue` `gfReset` `gfSummary`
- คงลำดับเดิมซึ่งตรงกับข้อกำหนดอยู่แล้ว (ค้นหา ▸ จังหวัด ▸ วิธีจัดหา ▸ ประเภท ▸ ระดับเสี่ยง ▸ กฎ ▸ มูลค่า ▸ ล้าง)
- คงคลาส grid เดิมทุกคอลัมน์
- เพิ่ม `<h2 class="visually-hidden" id="filterHeading">ตัวกรองข้อมูล</h2>` และ `aria-labelledby`
- เพิ่มป้าย `.section-label` ที่มองเห็นได้
- `#gfSummary` เพิ่ม `role="status"` (มี `aria-live="polite"` อยู่แล้ว)
- `#gfSearch` เพิ่ม `aria-describedby="gfSummary"`
- `#gfMinValue` เพิ่ม `aria-label` อธิบายหน่วยเป็นล้านบาท
- label เปล่าเหนือปุ่มล้าง เพิ่ม `for="gfReset"` (button เป็น labelable element ตามสเปก HTML)

## 6. KPI

- คง `id="kpis"` และ class `row g-3` เดิม (JavaScript แทรก `col-*` เข้ามาเอง)
- เพิ่ม class `analytics-kpi-grid` และหัวข้อ `.visually-hidden`
- ปรับสไตล์ `.kpi` ให้อ่านจากบนลงล่าง: ป้ายตัวพิมพ์ใหญ่ ▸ ตัวเลขใหญ่ ▸ คำอธิบาย
  พร้อมแถบสีด้านซ้าย และบังคับความสูงเท่ากันทุกใบ
- ใช้รูปแบบเดียวกันกับ `#fraudKpis` และ `#contractorKpis`

## 7. แท็บ

คง id, `data-bs-toggle`, `data-bs-target`, `role`, `aria-controls`, `aria-selected` ครบทั้ง 9 แท็บ
เปลี่ยนเฉพาะ**ข้อความที่แสดง** และเพิ่ม `title` ภาษาไทยกำกับทุกแท็บ

| id | เดิม | ใหม่ | title |
|---|---|---|---|
| pill-overview | ภาพรวม | Overview | ภาพรวมความเสี่ยงทั้งชุดข้อมูล |
| pill-explain | รายโครงการ + GIS | GIS | รายโครงการพร้อมแผนที่เชิงพื้นที่ |
| pill-fraud | Red Flags | Red Flags | สัญญาณเตือนความเสี่ยง |
| pill-anomaly | ความผิดปกติเชิงสถิติ | Anomaly Detection | ความผิดปกติเชิงสถิติ |
| pill-network | เครือข่าย | Network Analysis | เครือข่ายความสัมพันธ์ |
| pill-contractor | ผู้รับจ้าง | Contractors | การจัดลำดับความเสี่ยงผู้รับจ้าง |
| pill-time | แนวโน้มเวลา | Time Series | แนวโน้มตามช่วงเวลา |
| pill-rules | กฎและการตั้งค่า | Rules | ตารางอธิบายกฎและการปรับเงื่อนไข |
| pill-demo | ส่วนสาธิต | Demo | ส่วนสาธิตที่ใช้ข้อมูลสังเคราะห์ |

เพิ่ม `tabindex="0"` ที่ทุก `.tab-pane` เพื่อให้เลื่อนอ่านด้วยคีย์บอร์ดได้

## 8. Overview

จัดลำดับใหม่ตามข้อกำหนด (id ทุกตัวคงเดิม ตำแหน่งใน DOM เปลี่ยนได้เพราะ `renderOverview()`
เรียกแต่ละส่วนด้วย id ไม่ได้อาศัยลำดับ)

| ลำดับ | เนื้อหา | id | คอลัมน์ |
|---|---|---|---|
| 1 | Hero | `overviewLede` | เต็มแถว |
| 2 | แนวโน้มรายเดือน | `ovMonthly` | col-lg-8 |
| 3 | การกระจายระดับความเสี่ยง | `ovBandDonut` | col-lg-4 |
| 4 | ความถี่ของกฎ | `ovRuleBar` | col-lg-8 |
| 5 | สัดส่วนวิธีจัดหา | `ovMethodDonut` | col-lg-4 |
| 6 | สรุปรายหน่วยงาน | `ovAgencyBody` | col-lg-6 |
| 7 | โครงการเสี่ยงสูงสุด | `ovTopRiskBody` | col-lg-6 |

คง inline `style="height:..."` ของทุกกราฟ · เพิ่ม `role="img"` + `aria-label` ให้ทุกกราฟ ·
เพิ่ม `<caption class="visually-hidden">` ให้ทุกตาราง · เพิ่มคำอธิบายใต้หัวการ์ด

## 9. GIS

**เปลี่ยนโครงสร้างคอลัมน์** เพื่อให้ลำดับบนมือถือเป็น รายการ ▸ รายละเอียด ▸ แผนที่ ▸ กฎ ตามข้อกำหนด

- เดิม: `#rulesPanel` อยู่ในคอลัมน์เดียวกับ `#detail` ทำให้บนมือถือกฎมาก่อนแผนที่
- ใหม่: แถวที่ 1 = `#list` (col-xl-3) · `#detail` (col-xl-4) · `#mapCard` (col-xl-5)
  แถวที่ 2 = `#rulesPanel` (col-xl-7) · `#waterfall` (col-xl-5)
- ตรวจแล้วว่า `renderExplain()` เรียกทุกส่วนด้วย id ไม่ได้อาศัยความสัมพันธ์แม่ลูกระหว่างการ์ด
- `#mapCard` ยังคงหุ้ม `#map` ไว้เหมือนเดิม (จำเป็นสำหรับโหมดเต็มจอ)
- `.map-shell` ยังหุ้ม `#map` `#mapStats` `#mapLegend` ไว้ครบ (จำเป็นสำหรับการวางชั้นซ้อนทับ)

เพิ่ม: `role="application"` + `aria-label` ที่ `#map`, `role="status"` ที่ `#mapStats`,
`role="group"` ที่ `#mapLegend`, `title` ที่ปุ่มแผนที่ทุกปุ่ม, `role="group"` ที่ `.map-toolbar`

**แก้ความถูกต้องของ label 1 จุด:** เดิม `<label for="mapMode">` ชี้ไปยัง `<div id="mapMode">`
ซึ่งไม่ถูกต้องตามสเปก HTML (`for` ใช้ได้เฉพาะกับ labelable element)
เปลี่ยนเป็น `<span class="form-label" id="mapModeLabel">` และให้ปุ่มกลุ่มอ้างด้วย `aria-labelledby="mapModeLabel"`
**คง `id="mapMode"`, class `form-label` และข้อความเดิมไว้ทั้งหมด**

## 10. Red Flags

- คง id ครบ: `fraudKpis` `fraudDims` `fraudSeverityDonut` `fraudCategoryBar` `fraudHistogram`
  `tinMismatchBody` `splitContractBody` `noncompeteBody` `rotationBody` `fraudCaseCount`
  `fraudExport` `fraudCaseBody`
- ห่อ `#fraudKpis` และ `#fraudDims` ด้วย `<section>` พร้อมหัวข้อ `.visually-hidden`
  (คง class `row g-3` เดิม เพราะ JavaScript แทรก `col-*` เข้ามา)
- `#fraudExport` เพิ่ม class `.btn-primary-action` + `title` + `aria-label`
  ใช้สีหลักของระบบ ไม่ใช้สีแดง เพื่อไม่ให้เข้าใจผิดว่าเป็นปุ่มลบ
- ปรับข้อความ hero ให้ระบุชัดว่าเป็นการคัดกรอง ไม่ใช่ข้อสรุปว่ามีการกระทำผิด
- เพิ่ม `<caption class="visually-hidden">` ทุกตาราง และคำอธิบายใต้หัวการ์ด

## 11. Anomaly Detection

- คง id ครบ: `anCliffNote` `anCliffChart` `anRatioNote` `anRatioChart` `anBenfordNote`
  `anBenfordChart` `anBenfordBody` `anOutlierBody` `anDurationNote` `anDurationBody`
- กราฟหลัก 2 ใบอยู่แถวบน (หน้าผาราคา และอัตราส่วนราคา) กราฟสนับสนุนและตารางอยู่ล่าง
- เพิ่มข้อความเชิงคัดกรองในทุกจุดที่อาจถูกตีความผิด เช่น
  "ค่าที่สูงเป็นสัญญาณให้ตรวจสอบ ไม่ได้ชี้ว่าตัวเลขถูกแต่ง" และ
  "ราคาที่สูงกว่ากลุ่มอาจมีเหตุผลรองรับ ต้องดูขอบเขตงานประกอบ"

## 12. Network Analysis

- คง id และ class ครบ รวมถึง `.net-view-btn` กับ `data-view` ทั้ง 4 ค่า
- ลำดับใหม่: แถบเลือกมุมมอง ▸ ตัวกรอง ▸ `#networkChart` (col-xl-8) ▸
  รายการวิเคราะห์ (col-xl-4) ▸ `#netTableBody` (col-xl-8) ▸ `#screenTableBody` (col-12 ล่างสุด)
- `#screenTableBody` ย้ายจากคอลัมน์ 8 มาเป็นเต็มความกว้างด้านล่างตามข้อกำหนด
- คงพฤติกรรมสลับมุมมองทีละแบบ (แสดง visualization เดียวต่อครั้ง) เหมือนเดิม
- ทุก slider เพิ่ม `aria-describedby` ชี้ไปยัง span ที่แสดงค่าปัจจุบัน
  (`netMinContractsLabel` `netTopNLabel` `netMinValueLabel` — id เดิมทั้งหมด)

## 13. Contractors

- คง id ครบ รวม `contractorRiskMinLabel` และ `contractorContractMinLabel` ที่ JavaScript อัปเดตค่า
- ห่อ `#contractorKpis` ด้วย `<section>` พร้อมหัวข้อ `.visually-hidden`
- เพิ่มป้าย `.section-label` เหนือกลุ่มตัวกรองในการ์ดซ้าย
- slider ทั้งสองตัวเพิ่ม `aria-describedby`
- `warn-note` เพิ่ม `role="note"`

## 14. Time Series

- คง id ครบ: `tsDimension` `tsMetric` `tsNote` `timeChart` `tsMonthBody`
- คง inline height `420px` ของ `#timeChart`
- เพิ่มหัวข้อ `.visually-hidden` และป้าย `.section-label` ในการ์ดตัวเลือก
- เพิ่มคำอธิบายว่าแถวไฮไลต์คือเดือนที่มีสัญญาสูงสุด

## 15. Rules

- คง id ครบ: `ruleTableExport` `ruleTableBody` `ruleReset` `ruleSettings`
- `#ruleTableExport` อยู่มุมขวาบนของการ์ด เพิ่ม `.btn-primary-action`
- `#ruleReset` เป็นปุ่มกลาง (neutral) ไม่เน้นสี
- ตารางอยู่ใน `.table-wrap.rule-table-wrap` ซึ่งเลื่อนแนวนอนได้บนจอแคบ
- เพิ่ม `<caption class="visually-hidden">`

## 16. Demo

- คงข้อความเตือนเรื่องข้อมูลสังเคราะห์ทั้งหมด
- คง id: `demoDisclaimer` `kanban` `demoDirectorBody` `demoAddressBody` `demoSubcontractorBody`
- `#kanban` คง class `row g-3` เดิม (JavaScript แทรก `col-*`)
- เพิ่ม class `.demo-pane` ที่ตัว tab-pane ทำให้มีลายทางเฉียงจาง ๆ เป็นพื้นหลัง
  แยกจากแท็บที่ใช้ข้อมูลจริงอย่างชัดเจน แต่ยังอยู่ในระบบสีเดียวกัน
- เพิ่ม `<caption class="visually-hidden">` ที่ระบุว่าเป็น "ตัวอย่างสังเคราะห์" ทุกตาราง

## 17. Modal

- คง id ครบ: `detailModal` `detailModalTitle` `detailModalBody`
- คง `aria-labelledby="detailModalTitle"`, `aria-hidden="true"`, `tabindex="-1"`, `data-bs-dismiss`
- ปุ่มปิดเปลี่ยน `aria-label` จาก "ปิด" เป็น "ปิดหน้าต่างรายละเอียด" และเพิ่ม `title`
- `#detailModalBody` เพิ่ม `tabindex="0"` เพื่อให้เลื่อนอ่านด้วยคีย์บอร์ดได้

## 18. Script

**ไม่มีการเปลี่ยนแปลงใด ๆ** ลำดับและ query string เดิมทั้งหมด

```
Plotly → Leaflet → MarkerCluster → Leaflet.heat → Bootstrap
→ util.js → rules.js → analytics.js → charts.js → tablesort.js → app.js   (ทั้งหมด ?v=14)
```

ไม่มีการเพิ่ม `defer` หรือ `async`

---

## งานด้าน CSS ที่เพิ่มเข้ามา

ปรับใน `css/style.css` โดย**ไม่ลบ selector เดิม** มีการปรับค่าในกฎเดิมบางข้อ (สี ระยะห่าง เงา)

| หัวข้อ | รายละเอียด |
|---|---|
| ระบบสี | พื้นหลังเปลี่ยนจากครีม `#f5f4ef` เป็นเทาอมฟ้า `#f4f6f8` · เพิ่ม `--border-strong`, `--teal-dark`, `--gap-section`, `--radius-card` |
| ตัวอักษร | ขนาดฐาน `.94rem` · `line-height 1.55` · ตัวเลขใช้ `tabular-nums` ทั้งหน้า |
| การ์ด | เงาบางลงมาก (`0 1px 2px`) จากเดิมที่ฟุ้ง (`0 8px 24px`) · หัวการ์ดมีเส้นคั่นบาง |
| Hero | เปลี่ยนจากไล่สีเข้มตัวอักษรขาว เป็นพื้นสว่างตัวอักษรเข้ม + แถบสีด้านซ้าย |
| ตาราง | หัวตารางตัวพิมพ์ใหญ่ขนาดเล็ก พื้นเทาอ่อน · แถวสลับสีจาง · hover ชัดขึ้น |
| แท็บ | มุมมนน้อยลง (8px) ตัวอักษรกระชับ · sticky ใต้ topbar บนจอกว้าง |
| Topbar | เส้นไล่สีบาง 3px ด้านบน · ตราตัวอักษร · ปุ่มหลัก/รอง แยกน้ำหนักชัด |
| การเข้าถึง | `.skip-link` · `:focus-visible` ที่แท็บ |

---

## ผลการตรวจสอบ

### ตรวจแบบอัตโนมัติ

| รายการ | ผล |
|---|---|
| id ซ้ำในไฟล์ | ไม่มี |
| id เดิม 131 รายการ | **อยู่ครบทั้งหมด ไม่มีหาย** |
| id ที่ JavaScript อ้างถึง 111 รายการ | พบใน HTML ครบ |
| `aria-controls` / `aria-labelledby` / `aria-describedby` | ชี้ไปยัง id ที่มีจริงทุกตัว |
| `label for` 26 รายการ | ชี้ไปยัง element ฟอร์มที่มีจริงทุกตัว |
| `data-bs-toggle="pill"` / `data-bs-target` / `data-view` / `data-mapmode` / `data-bs-dismiss` | จำนวนเท่าเดิมทุกกลุ่ม (9/9/4/3/1) |
| class เดิมที่ JS และ CSS ใช้ 27 ตัว | อยู่ครบ |
| ลำดับ script 11 ไฟล์ | ถูกต้อง ไม่มี defer/async |
| โครงสร้างและการปิดแท็ก | ถูกต้อง |
| inline height ของกราฟ 15 จุด | คงอยู่ครบ |

### ตรวจขณะรันจริง

| รายการ | ผล |
|---|---|
| console error | **0 รายการ** |
| โหลดข้อมูล | 10,174 ระเบียน |
| ทั้ง 9 แท็บ render | ครบ จำนวนกราฟและแถวตารางเท่าเดิมทุกแท็บ |
| ตัวกรองส่วนกลาง | เลือกภูเก็ต → 106 สัญญา · ล้าง → 10,174 |
| แผนที่ | 7 Leaflet pane · 24 กลุ่มหมุด · คำอธิบาย 5 กลุ่ม · สลับโหมดความหนาแน่นได้ |
| เครือข่าย | สลับเป็นตารางความร้อนได้ (`heatmap`) |
| การเรียงตาราง | หัวคอลัมน์เรียงได้ ผลลัพธ์ถูกต้อง |
| modal | เปิดได้ มีเนื้อหา ปิดได้ |
| id ปุ่ม export/reset/filter | ครบและทำงาน |

### ตรวจการแสดงผลตามความกว้างจอ

| ความกว้าง | หน้าล้นแนวนอน | หมายเหตุ |
|---|---|---|
| 1440px | ไม่ล้น | เลย์เอาต์ 12 คอลัมน์เต็มรูปแบบ |
| 1280px | ไม่ล้น | — |
| 768px | ไม่ล้น | การ์ดยุบเป็น 1-2 คอลัมน์ |
| 390px | ไม่ล้น | KPI 2 ใบต่อแถว · แท็บตัดขึ้นบรรทัดใหม่ |

ที่ 390px ตรวจเพิ่มด้วยว่าไม่มี element ใดล้นออกนอกจอโดยที่ไม่ได้อยู่ในกล่องที่เลื่อนได้
(`realOverflowOutsideScrollers` = ว่าง) ส่วนตารางที่กว้างเกินจอจะเลื่อนแนวนอนภายใน
`.table-wrap` ตามที่ข้อกำหนดระบุไว้

---

## สิ่งที่ยังทำไม่ได้ / ข้อจำกัดที่เหลืออยู่

1. **โครงสร้างคอลัมน์ของแท็บ GIS เปลี่ยนไป** — ข้อกำหนดต้องการทั้ง
   "desktop: detail/rules อยู่ในคอลัมน์ 4 เดียวกัน" และ "mobile: list ▸ detail ▸ map ▸ rules"
   สองข้อนี้ขัดกันเอง เพราะบนมือถือลำดับการแสดงผลคือลำดับใน DOM
   ถ้า rules อยู่ในคอลัมน์เดียวกับ detail มันจะมาก่อน map เสมอ
   จึงเลือกทำตามข้อกำหนดเรื่องลำดับบนมือถือ แล้วย้าย rules ลงแถวที่สอง
   หากต้องการให้ detail กับ rules อยู่คอลัมน์เดียวกันบนเดสก์ท็อปจริง ๆ ต้องยอมให้ลำดับบนมือถือ
   เป็น list ▸ detail ▸ rules ▸ map แทน

2. **ป้ายแท็บเป็นภาษาอังกฤษปนกับ UI ภาษาไทย** — ทำตามข้อกำหนดข้อ 7 ที่ระบุชื่อไว้ชัดเจน
   แต่ส่วนอื่นของระบบเป็นภาษาไทยทั้งหมด จึงกำกับ `title` ภาษาไทยไว้ทุกแท็บ
   หากต้องการกลับเป็นภาษาไทย ให้แก้ข้อความระหว่าง `>` กับ `</button>` ของปุ่ม `pill-*`
   โดยไม่ต้องแตะ id หรือ attribute อื่น

3. **ไม่ได้ทำ advanced filter แบบซ่อน/แสดง** — ข้อกำหนดอนุญาตให้ทำ "เฉพาะเมื่อไม่กระทบ JavaScript"
   ตัวกรองทั้ง 7 ตัวถูกอ่านค่าพร้อมกันใน `syncFiltersFromUI()` ทุกครั้งที่มีการเปลี่ยนแปลง
   การซ่อนด้วย `display:none` ยังอ่านค่าได้ก็จริง แต่ผู้ใช้จะไม่เห็นว่ามีตัวกรองทำงานค้างอยู่
   ซึ่งเสี่ยงต่อการตีความข้อมูลผิดในงานตรวจสอบ จึงเลือกแสดงทั้งหมดตลอดเวลา

4. **`role="application"` ที่ `#map`** — ทำให้โปรแกรมอ่านหน้าจอส่งปุ่มลูกศรให้ Leaflet โดยตรง
   ซึ่งถูกต้องสำหรับแผนที่ที่โต้ตอบได้ แต่ผู้ใช้ต้องกด Escape เพื่อออกจากโหมดนั้น
   หากพบว่าสร้างความสับสนในการใช้งานจริง ให้เปลี่ยนเป็น `role="region"`

5. **ยังไม่ได้ทดสอบกับโปรแกรมอ่านหน้าจอจริง** — การตรวจ ARIA ทั้งหมดเป็นการตรวจว่า
   attribute ชี้ไปยัง id ที่มีอยู่จริงเท่านั้น ยังไม่ได้ทดสอบกับ NVDA หรือ JAWS

6. **CSS มีการแก้กฎเดิม ไม่ใช่เพิ่มอย่างเดียว** — เช่น `.cardx`, `.kpi`, `.hero*`, `.mini-table th`,
   `.nav-pills .nav-link` เพราะการเปลี่ยนภาษาภาพให้เป็นทางการขึ้นทำด้วยการเพิ่ม class อย่างเดียวไม่ได้
   ไม่มี selector ใดถูกลบ และไฟล์เดิมสำรองไว้ที่ `backup/style.before-ui-redesign.css`
