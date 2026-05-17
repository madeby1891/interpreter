#!/usr/bin/env python3
"""
Generate the public PDF of the Deaf-owned verification standard.
Output: site/assets/docs/deaf-owned-verification-standard.pdf
"""
from pathlib import Path
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle
from datetime import date

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "site" / "assets" / "docs" / "deaf-owned-verification-standard.pdf"
OUT.parent.mkdir(parents=True, exist_ok=True)

BLOOM = colors.HexColor("#9E3F2C")
INK = colors.HexColor("#0F1419")
FOG = colors.HexColor("#5C6670")
RIVER = colors.HexColor("#2E5E5C")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="Title1891", fontName="Times-Bold", fontSize=24, leading=28,
    textColor=INK, spaceAfter=12,
))
styles.add(ParagraphStyle(
    name="Subtitle1891", fontName="Helvetica", fontSize=11, leading=14,
    textColor=FOG, spaceAfter=24,
))
styles.add(ParagraphStyle(
    name="H2", fontName="Times-Bold", fontSize=15, leading=18,
    textColor=BLOOM, spaceBefore=18, spaceAfter=8,
))
styles.add(ParagraphStyle(
    name="Body1891", fontName="Helvetica", fontSize=10.5, leading=15,
    textColor=INK, spaceAfter=8, alignment=TA_LEFT,
))
styles.add(ParagraphStyle(
    name="Quote1891", fontName="Times-Italic", fontSize=12, leading=17,
    textColor=RIVER, leftIndent=18, rightIndent=18,
    spaceBefore=12, spaceAfter=12, borderPadding=8,
))
styles.add(ParagraphStyle(
    name="Footer1891", fontName="Helvetica-Oblique", fontSize=8.5, leading=11,
    textColor=FOG, alignment=TA_CENTER,
))


def header_footer(canvas, doc):
    canvas.saveState()
    # Header
    canvas.setFont("Times-Bold", 9)
    canvas.setFillColor(BLOOM)
    canvas.drawString(0.75 * inch, 10.4 * inch, "1891 Interpreter — Deaf-owned verification standard")
    canvas.setFont("Helvetica", 8.5)
    canvas.setFillColor(FOG)
    canvas.drawRightString(7.75 * inch, 10.4 * inch, f"v1.0 · {date.today().isoformat()}")
    canvas.setStrokeColor(colors.HexColor("#E4E0D6"))
    canvas.setLineWidth(0.5)
    canvas.line(0.75 * inch, 10.32 * inch, 7.75 * inch, 10.32 * inch)
    # Footer
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(FOG)
    canvas.drawString(0.75 * inch, 0.4 * inch, "1891 LLC · Frederick, Maryland · hello@madeby1891.com")
    canvas.drawRightString(7.75 * inch, 0.4 * inch, f"Page {doc.page}")
    canvas.restoreState()


def build():
    doc = SimpleDocTemplate(
        str(OUT), pagesize=LETTER,
        leftMargin=0.75 * inch, rightMargin=0.75 * inch,
        topMargin=0.95 * inch, bottomMargin=0.7 * inch,
        title="1891 Interpreter — Deaf-owned verification standard",
        author="1891 LLC",
        subject="Deaf-owned business verification standard for the Free Forever tier",
    )
    story = []

    story.append(Paragraph("Deaf-owned verification standard", styles["Title1891"]))
    story.append(Paragraph(
        "Public mirror of the standard the verification board applies for the Free Forever tier. "
        "Version 1.0 · " + date.today().isoformat(),
        styles["Subtitle1891"],
    ))

    story.append(Paragraph("The definition", styles["H2"]))
    story.append(Paragraph(
        "A Deaf-owned agency, for purposes of the Free Forever tier, is an agency where a Deaf, DeafBlind, or "
        "hard-of-hearing person — or a group of such persons — holds <b>more than 50% of ownership interest "
        "and exercises operational control</b>. We use the same baseline that state DBE/MBE and SBA programs use.",
        styles["Body1891"],
    ))

    story.append(Paragraph("Documentation we accept", styles["H2"]))
    for item in [
        "State Deaf-owned business certification (where the state offers one).",
        "SBA self-certification for a Deaf-owned small business.",
        "NAD agency-member designation (where applicable to the agency's classification).",
        "A sworn attestation, signed by the owner, used where no state pathway exists. One page, plain English. "
        "Fallon co-signs the program-level standard so the attestation is verifying against a clear definition, not a vibe.",
    ]:
        story.append(Paragraph("•&nbsp;&nbsp; " + item, styles["Body1891"]))

    story.append(Paragraph("The workflow", styles["H2"]))
    steps = [
        ("1. Apply.", "Owner submits the public form at /free-for-deaf-owned: agency legal name, state of formation, owner name, contact email, documentation type."),
        ("2. Acknowledge.", "Auto-reply within 5 minutes. A real person (Fallon or board secretary) confirms receipt within 2 business days."),
        ("3. Board review.", "The verification board — Fallon plus two community advisors, rotating — reviews within 5 business days. Decision is binary (approve / deny) with a written reason either way."),
        ("4. Approve path.", "Tier flipped to Free Forever the same day. Badge (\"Deaf-owned · 1891 verified\") becomes available for your public profile and as an embeddable SVG for your own site. BAA auto-attached."),
        ("5. Annual recertification.", "Light. Once a year we email: \"still owned by the same person/people? Reply yes.\" No re-documentation unless ownership changed."),
        ("6. Deny path.", "Reasoned response. Appeal within 30 days. <b>All denials are reviewed by the full board, not a single reviewer.</b> A denied agency is welcome on a paid tier — the badge is the gate, not the platform."),
        ("7. Withdraw.", "If ownership changes such that you no longer qualify, the badge comes down and you transition to the appropriate paid tier with 90 days' notice. No service interruption."),
    ]
    for label, body in steps:
        story.append(Paragraph(f"<b>{label}</b>&nbsp; {body}", styles["Body1891"]))

    story.append(Paragraph("Edge cases", styles["H2"]))
    edge = [
        ("Deaf-CODA-owned agency.", "The CODA is hearing. Not Deaf-owned by our standard; eligible for paid tier. The badge stays a Deaf-ownership marker."),
        ("Mixed-ownership at 51% Deaf-owned.", "Qualifies. The standard is >50% ownership; 51% is more than 50%."),
        ("Deaf-led nonprofit.", "Nonprofits don't have \"owners\" in the equity sense. If the executive director and the majority of the board are Deaf, the agency qualifies. Documented via board minutes or 990 attestation. Reviewed individually."),
        ("Hearing-allied agency.", "Not eligible for the badge. Eligible for every paid tier. We don't do honorary allyship badges."),
        ("Paper ownership vs. operational control.", "The standard requires operational control, not just paper ownership. Reviewed by the full board; the burden is on the applicant. We err toward approval if documentation is reasonable; we deny if it looks like a workaround."),
    ]
    for label, body in edge:
        story.append(Paragraph(f"<b>{label}</b>&nbsp; {body}", styles["Body1891"]))

    story.append(Paragraph("The board", styles["H2"]))
    story.append(Paragraph(
        "Fallon Brizendine (CDI, MA Interpretation, Gallaudet) plus two community advisors rotating annually. "
        "The community advisors are drawn from a pool with explicit standing in the Deaf agency-owner community. "
        "The board reviews every application within 5 business days. All denials are reviewed by the full board, "
        "not a single reviewer.",
        styles["Body1891"],
    ))

    story.append(Spacer(1, 16))
    story.append(Paragraph(
        '"We will get this wrong sometimes. When we do, the board reconsiders. The badge means something because we '
        "hold it to a standard, and the standard exists because the community asked for one.\"",
        styles["Quote1891"],
    ))

    story.append(Spacer(1, 12))
    story.append(Paragraph(
        "Live HTML mirror: https://madeby1891.com/interpreter/legal/deaf-owned-verification-standard.html<br/>"
        "Apply: https://madeby1891.com/interpreter/free-for-deaf-owned.html<br/>"
        "Contact: hello@madeby1891.com",
        styles["Body1891"],
    ))

    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
    print(f"Wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    build()
