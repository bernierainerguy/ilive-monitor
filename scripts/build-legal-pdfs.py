#!/usr/bin/env python3
"""
build-legal-pdfs.py

Generates the three Whiteley Events A&H iLive Monitor (WEIM) legal PDFs from markdown source
(adapted from the WESC generator):
  legal/WEIM-EULA.md                 -> legal/WEIM-EULA.pdf
  legal/WEIM-Privacy-Notice.md       -> legal/WEIM-Privacy-Notice.pdf
  (third-party licences generated from production dependencies)
                                     -> legal/WEIM-Third-Party-Licences.pdf

Requires: reportlab (pip install reportlab)
Also enumerates production npm dependencies for the third-party licences PDF —
run `npm ci --omit=dev` first so node_modules only contains production deps,
or the output will include devDependencies.

Usage:  python3 scripts/build-legal-pdfs.py
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

try:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.lib import colors
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak,
        KeepTogether,
    )
except ImportError:
    # Modern macOS Python (Homebrew / Python.org installer) refuses
    # `pip install reportlab` in the system environment unless told to
    # explicitly. Without the --break-system-packages hint, an operator
    # running the release script for the first time hits a confusing
    # PEP 668 error and has to Google. Surface both options.
    sys.stderr.write(
        "reportlab is required.\n"
        "Try one of:\n"
        "  pip install reportlab\n"
        "  pip install --break-system-packages reportlab    (modern macOS / Homebrew Python)\n"
        "  python3 -m pip install --user reportlab\n"
    )
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
LEGAL = ROOT / "legal"
PACKAGE_VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]

COMPANY = "Whiteley Events Ltd"
COMPANY_NO = "08229242"
ADDRESS = "Decibel House, 32 Thyme Avenue, Whiteley, PO15 7NA"
FOOTER = f"{COMPANY} • Company No. {COMPANY_NO} • {ADDRESS}"
PRODUCT = "Whiteley Events A&amp;H iLive Monitor (WEIM)"
PRODUCT_SHORT = "Whiteley Events A&amp;H iLive Monitor"
# Keep in step with EULA_VERSION in src/main/services/LegalService.ts.
EFFECTIVE = "25 September 2026"

# ─── Styles ────────────────────────────────────────────────────────────────

def build_styles():
    ss = getSampleStyleSheet()
    base = ss["BodyText"]
    base.fontSize = 10
    base.leading = 14
    base.spaceAfter = 6
    return {
        "title": ParagraphStyle("Title", parent=ss["Title"], fontSize=20,
                                leading=24, spaceAfter=6, alignment=1),
        "subtitle": ParagraphStyle("SubTitle", parent=ss["Normal"], fontSize=10,
                                   leading=14, spaceAfter=18, alignment=1,
                                   textColor=colors.grey),
        "h2": ParagraphStyle("H2", parent=ss["Heading2"], fontSize=12,
                             leading=15, spaceBefore=12, spaceAfter=4,
                             textColor=colors.black),
        "h3": ParagraphStyle("H3", parent=ss["Heading3"], fontSize=10.5,
                             leading=13, spaceBefore=8, spaceAfter=3,
                             textColor=colors.black),
        "body": base,
        "bullet": ParagraphStyle("Bullet", parent=base, leftIndent=14,
                                 bulletIndent=0, spaceAfter=3),
        "footer_note": ParagraphStyle("Footer", parent=ss["Normal"], fontSize=8,
                                      leading=10, textColor=colors.grey,
                                      spaceBefore=14),
    }

# ─── Markdown -> flowables (handles the dialect used in the .md files) ─────

INLINE_BOLD = re.compile(r"\*\*(.+?)\*\*")
INLINE_CODE = re.compile(r"`([^`]+)`")

def inline(md: str) -> str:
    md = INLINE_BOLD.sub(r"<b>\1</b>", md)
    md = INLINE_CODE.sub(r"<font face='Courier'>\1</font>", md)
    # Escape ampersands that aren't already entities
    md = re.sub(r"&(?!(amp|lt|gt|quot|apos);)", "&amp;", md)
    return md

def md_to_story(md_path: Path, styles) -> list:
    text = md_path.read_text(encoding="utf-8").splitlines()
    story = []
    buf = []           # paragraph accumulator
    bullets = []       # current bullet list

    def flush_para():
        nonlocal buf
        if buf:
            story.append(Paragraph(inline(" ".join(buf)), styles["body"]))
            buf = []

    def flush_bullets():
        nonlocal bullets
        if bullets:
            for b in bullets:
                story.append(Paragraph("• " + inline(b), styles["bullet"]))
            story.append(Spacer(1, 4))
            bullets = []

    subtitle_done = False
    for raw in text:
        line = raw.rstrip()
        if not line.strip():
            flush_para(); flush_bullets()
            continue
        if line.startswith("# "):
            flush_para(); flush_bullets()
            story.append(Paragraph(inline(line[2:]), styles["title"]))
            continue
        if line.startswith("### "):
            flush_para(); flush_bullets()
            story.append(Paragraph(inline(line[4:]), styles["h3"]))
            continue
        if line.startswith("## "):
            flush_para(); flush_bullets()
            story.append(Paragraph(inline(line[3:]), styles["h2"]))
            continue
        # The version line (a wholly bold line next to the title) is the subtitle.
        if line.startswith("**") and line.endswith("**") and not subtitle_done and not story[1:]:
            flush_para(); flush_bullets()
            story.append(Paragraph(inline(line), styles["subtitle"]))
            subtitle_done = True
            continue
        if line.strip() == "---":
            flush_para(); flush_bullets()
            story.append(Spacer(1, 8))
            continue
        if line.startswith("- "):
            flush_para()
            bullets.append(line[2:])
            continue
        flush_bullets()
        buf.append(line)

    flush_para(); flush_bullets()
    return story

# ─── PDF template with footer ──────────────────────────────────────────────

def make_doc(out_path: Path):
    doc = SimpleDocTemplate(
        str(out_path),
        pagesize=A4,
        leftMargin=22 * mm, rightMargin=22 * mm,
        topMargin=20 * mm, bottomMargin=22 * mm,
        title=out_path.stem.replace("-", " "),
        author=COMPANY,
    )
    return doc

def on_page(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillGray(0.4)
    canvas.drawString(22 * mm, 12 * mm, FOOTER)
    canvas.drawRightString(A4[0] - 22 * mm, 12 * mm, f"Page {doc.page}")
    canvas.restoreState()

def render(md_path: Path, out_path: Path, styles):
    doc = make_doc(out_path)
    story = md_to_story(md_path, styles)
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    print(f"  -> {out_path.relative_to(ROOT)}")

# ─── Third-party licences (enumerate node_modules) ─────────────────────────

def collect_prod_packages():
    """Enumerate installed production dependencies from package-lock.json.

    npm 11's `npm ls --json` output no longer includes each dependency's
    filesystem path. The old generator consequently labelled every package
    UNLICENSED even when its package.json contained a valid licence. Lockfile
    package entries retain the production/dev classification and exact
    node_modules path, so use those as the reproducible source of truth.
    """
    try:
        lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        sys.stderr.write(f"package-lock.json could not be read: {e}\n")
        return {}

    packages = {}
    for rel_path, info in (lock.get("packages") or {}).items():
        if not rel_path or "/node_modules/" not in f"/{rel_path}" or info.get("dev") is True:
            continue
        marker = "node_modules/"
        tail = rel_path.rsplit(marker, 1)[-1]
        parts = tail.split("/")
        name = "/".join(parts[:2]) if tail.startswith("@") else parts[0]
        version = info.get("version", "?")
        key = f"{name}@{version}:{rel_path}"
        packages[key] = {
            "name": name,
            "version": version,
            "path": str(ROOT / rel_path),
            "license": info.get("license") or "Unknown",
        }
    return packages

def read_package_licence(pkg_path: str):
    pj = Path(pkg_path) / "package.json"
    if not pj.exists():
        return "Unknown", ""
    try:
        data = json.loads(pj.read_text(encoding="utf-8"))
    except Exception:
        return "Unknown", ""
    lic = data.get("license") or data.get("licenses") or "Unknown"
    if isinstance(lic, list):
        parts = [l.get("type") if isinstance(l, dict) else str(l) for l in lic]
        lic = " / ".join(p for p in parts if p)
    elif isinstance(lic, dict):
        lic = lic.get("type", "Unknown")
    repo = data.get("repository")
    if isinstance(repo, dict):
        repo = repo.get("url", "")
    repo = (repo or "").replace("git+", "").replace(".git", "").replace("https://", "").replace("http://", "")
    return str(lic or "Unknown"), repo

def build_third_party_pdf(out_path: Path, styles):
    packages = collect_prod_packages()
    enriched = []
    for key, info in sorted(packages.items(), key=lambda kv: kv[0].lower()):
        lic, repo = read_package_licence(info["path"])
        if lic == "Unknown":
            lic = info.get("license") or "Unknown"
        enriched.append((info["name"], info["version"], lic, repo))

    counts = Counter(p[2] for p in enriched)
    doc = make_doc(out_path)
    story = []

    story.append(Paragraph("Third-party Licence Notices", styles["title"]))
    story.append(Paragraph(
        f"{PRODUCT} • Version {PACKAGE_VERSION} • Effective {EFFECTIVE}",
        styles["subtitle"]))
    story.append(Paragraph(
        f"{PRODUCT_SHORT} includes open-source software developed by third parties. This notice lists "
        "each production dependency bundled with the application and the licence under "
        "which it is distributed. The full text of each licence is included with the "
        "corresponding package in the application's node_modules directory. Nothing in "
        "this notice modifies any open-source licence; where any open-source licence "
        "conflicts with our End User Licence Agreement in respect of the component it "
        "governs, the open-source licence prevails for that component only.",
        styles["body"]))

    story.append(Spacer(1, 8))
    story.append(Paragraph("Electron and Chromium", styles["h2"]))
    story.append(Paragraph(
        f"{PRODUCT_SHORT} is built on Electron (MIT licence), which includes Chromium and Node.js. "
        "Their licence notices are bundled inside the application at "
        "<font face='Courier'>Contents/Resources/LICENSES.chromium.html</font> and "
        "<font face='Courier'>Contents/Resources/LICENSE</font>.",
        styles["body"]))
    story.append(Spacer(1, 8))

    if not enriched:
        story.append(Spacer(1, 8))
        story.append(Paragraph(
            "<i>No production dependencies were found. Run <font face='Courier'>npm ci --omit=dev</font> "
            "before regenerating this document so the list reflects what is shipped.</i>",
            styles["body"]))
        doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
        print(f"  -> {out_path.relative_to(ROOT)} (empty — run npm ci --omit=dev first)")
        return

    story.append(Spacer(1, 10))
    story.append(Paragraph("Summary by licence", styles["h2"]))
    summary = [["Licence", "Packages"]]
    for lic, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        summary.append([lic, str(n)])
    summary.append(["Total", str(sum(counts.values()))])
    t = Table(summary, colWidths=[120 * mm, 30 * mm])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(t)

    story.append(PageBreak())
    story.append(Paragraph("Full dependency list", styles["h2"]))
    rows = [["Package", "Version", "Licence", "Repository"]]
    for name, version, lic, repo in enriched:
        rows.append([name, version, lic, repo or ""])
    t = Table(rows, colWidths=[50 * mm, 20 * mm, 30 * mm, 60 * mm], repeatRows=1)
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.grey),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(t)

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    print(f"  -> {out_path.relative_to(ROOT)} ({len(enriched)} packages)")

# ─── Entry point ───────────────────────────────────────────────────────────

def main():
    LEGAL.mkdir(parents=True, exist_ok=True)
    styles = build_styles()
    print("Building WEIM legal PDFs...")
    render(LEGAL / "WEIM-EULA.md", LEGAL / "WEIM-EULA.pdf", styles)
    render(LEGAL / "WEIM-Privacy-Notice.md", LEGAL / "WEIM-Privacy-Notice.pdf", styles)
    build_third_party_pdf(LEGAL / "WEIM-Third-Party-Licences.pdf", styles)
    print("Done.")

if __name__ == "__main__":
    main()
