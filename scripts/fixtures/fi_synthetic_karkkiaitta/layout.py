"""Small deterministic PDF layout helpers on top of ReportLab's canvas.

Only the 14 standard PDF fonts are used (Helvetica, Courier), so no font file
is read from the machine: with the pinned ReportLab version and invariant=1
the output is byte-identical on every run and every host.
"""

from __future__ import annotations

from decimal import Decimal

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.units import mm
from reportlab.lib.utils import simpleSplit
from reportlab.pdfgen import canvas

SYN = "SYNTEETTINEN TESTIAINEISTO"
GREY = colors.Color(0.45, 0.45, 0.45)
LIGHT = colors.Color(0.93, 0.93, 0.93)
MID = colors.Color(0.80, 0.80, 0.80)


def fi(x, plus=False) -> str:
    """1 234,56 (Finnish/Swedish)."""
    x = Decimal(x)
    s = f"{abs(x):,.2f}".replace(",", " ").replace(".", ",")
    sign = "-" if x < 0 else ("+" if plus and x > 0 else "")
    return sign + s


def en(x, plus=False) -> str:
    x = Decimal(x)
    s = f"{abs(x):,.2f}"
    sign = "-" if x < 0 else ("+" if plus and x > 0 else "")
    return sign + s


def de(x, plus=False) -> str:
    x = Decimal(x)
    s = f"{abs(x):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    sign = "-" if x < 0 else ("+" if plus and x > 0 else "")
    return sign + s


def fdate(iso: str, style="fi") -> str:
    y, mo, d = iso.split("-")
    if style == "fi":
        return f"{d}.{mo}.{y}"
    if style == "de":
        return f"{d}.{mo}.{y}"
    if style == "en":
        months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return f"{int(d)} {months[int(mo) - 1]} {y}"
    if style == "iso":
        return iso
    raise ValueError(style)


class Doc:
    def __init__(self, path, title, pagesize=A4, landscape_=False, margin=16 * mm, footer_note=SYN, font="Helvetica"):
        ps = landscape(pagesize) if landscape_ else pagesize
        self.c = canvas.Canvas(str(path), pagesize=ps, invariant=1, pageCompression=1)
        self.c.setTitle(title)
        self.c.setAuthor("")
        self.c.setCreator("fi_synthetic_karkkiaitta")
        self.c.setProducer("ReportLab")
        self.W, self.H = ps
        self.m = margin
        self.x0, self.x1 = margin, self.W - margin
        self.y = self.H - margin
        self.bottom = margin + 10
        self.page = 1
        self.footer_note = footer_note
        self.font = font
        self.bold = font + "-Bold" if font in ("Helvetica", "Courier") else font

    # ------------------------------------------------------------ basics
    def footer(self):
        c = self.c
        c.setFont("Helvetica", 6)
        c.setFillColor(GREY)
        c.drawCentredString(self.W / 2, self.m / 2, f"{self.footer_note} · sivu {self.page}")
        c.setFillColor(colors.black)

    def newpage(self):
        self.footer()
        self.c.showPage()
        self.page += 1
        self.y = self.H - self.m

    def need(self, h):
        if self.y - h < self.bottom:
            self.newpage()

    def space(self, h=4):
        self.y -= h

    def save(self):
        self.footer()
        self.c.save()

    def text(self, s, size=9, bold=False, x=None, align="left", color=colors.black, font=None, lead=None):
        self.need(size + 2)
        c = self.c
        c.setFont(font or (self.bold if bold else self.font), size)
        c.setFillColor(color)
        xx = self.x0 if x is None else x
        if align == "left":
            c.drawString(xx, self.y - size, s)
        elif align == "right":
            c.drawRightString(self.x1 if x is None else x, self.y - size, s)
        else:
            c.drawCentredString(self.W / 2 if x is None else x, self.y - size, s)
        c.setFillColor(colors.black)
        self.y -= lead or (size + 3)

    def at(self, x, y, s, size=9, bold=False, align="left", color=colors.black, font=None):
        c = self.c
        c.setFont(font or (self.bold if bold else self.font), size)
        c.setFillColor(color)
        if align == "left":
            c.drawString(x, y, s)
        elif align == "right":
            c.drawRightString(x, y, s)
        else:
            c.drawCentredString(x, y, s)
        c.setFillColor(colors.black)

    def para(self, s, size=8.5, width=None, x=None, bold=False, lead=None, color=colors.black):
        width = width or (self.x1 - self.x0)
        lead = lead or size * 1.3
        font = self.bold if bold else self.font
        for chunk in s.split("\n"):
            lines = simpleSplit(chunk, font, size, width) or [""]
            for ln in lines:
                self.need(lead)
                self.c.setFont(font, size)
                self.c.setFillColor(color)
                self.c.drawString(self.x0 if x is None else x, self.y - size, ln)
                self.y -= lead
        self.c.setFillColor(colors.black)

    def hr(self, w=0.5, color=MID):
        self.need(4)
        self.c.setStrokeColor(color)
        self.c.setLineWidth(w)
        self.c.line(self.x0, self.y - 1, self.x1, self.y - 1)
        self.c.setStrokeColor(colors.black)
        self.y -= 5

    def band(self, s, size=11, fill=colors.Color(0.15, 0.25, 0.45), color=colors.white, h=None):
        h = h or size + 9
        self.need(h + 2)
        self.c.setFillColor(fill)
        self.c.rect(self.x0, self.y - h, self.x1 - self.x0, h, stroke=0, fill=1)
        self.c.setFillColor(color)
        self.c.setFont(self.bold, size)
        self.c.drawString(self.x0 + 6, self.y - h + (h - size) / 2 + 1.5, s)
        self.c.setFillColor(colors.black)
        self.y -= h + 4

    def kv(self, pairs, x=None, width=None, size=8.5, keyw=None, lead=None):
        """Key/value lines. Returns the height used."""
        x = self.x0 if x is None else x
        width = width or (self.x1 - x)
        keyw = keyw or width * 0.42
        lead = lead or size * 1.35
        y0 = self.y
        for k, v in pairs:
            vlines = simpleSplit(str(v), self.font, size, width - keyw) or [""]
            self.need(lead * len(vlines))
            self.c.setFont(self.font, size - 0.5)
            self.c.setFillColor(GREY)
            self.c.drawString(x, self.y - size, k)
            self.c.setFillColor(colors.black)
            self.c.setFont(self.font, size)
            for i, vl in enumerate(vlines):
                self.c.drawString(x + keyw, self.y - size, vl)
                self.y -= lead
        return y0 - self.y

    def two_col(self, left_fn, right_fn, split=0.5):
        """Render two blocks side by side; each fn(x, width) draws using self.y. Final y = min."""
        y0 = self.y
        w = self.x1 - self.x0
        left_fn(self.x0, w * split - 8)
        yl = self.y
        self.y = y0
        right_fn(self.x0 + w * split, w * (1 - split))
        self.y = min(yl, self.y)

    def lines_at(self, x, lines, size=8.5, bold_first=False, lead=None):
        lead = lead or size * 1.3
        for i, ln in enumerate(lines):
            self.c.setFont(self.bold if (bold_first and i == 0) else self.font, size)
            self.c.drawString(x, self.y - size, ln)
            self.y -= lead

    def table(self, headers, rows, widths, aligns=None, size=7.8, header_fill=LIGHT, bold_rows=(), zebra=False,
              pad=2.2, wrap=True, rule_rows=(), font=None, header_size=None):
        """widths are fractions of the usable width (or absolute if > 1)."""
        W = self.x1 - self.x0
        ws = [w * W if w <= 1 else w for w in widths]
        aligns = aligns or ["left"] * len(headers)
        font = font or self.font
        bfont = self.bold if font == self.font else font + "-Bold"
        hs = header_size or size

        def draw_row(cells, bold=False, fill=None, is_header=False):
            fnt = bfont if (bold or is_header) else font
            sz = hs if is_header else size
            wrapped = []
            for cell, w in zip(cells, ws):
                s = "" if cell is None else str(cell)
                parts = []
                for chunk in s.split("\n"):
                    parts += (simpleSplit(chunk, fnt, sz, w - 2 * pad) if wrap else [chunk]) or [""]
                wrapped.append(parts)
            nlines = max(len(p) for p in wrapped)
            h = nlines * sz * 1.22 + 2 * pad
            if self.y - h < self.bottom:
                self.newpage()
                if not is_header and headers:
                    draw_row(headers, is_header=True, fill=header_fill)
            if fill is not None:
                self.c.setFillColor(fill)
                self.c.rect(self.x0, self.y - h, W, h, stroke=0, fill=1)
                self.c.setFillColor(colors.black)
            x = self.x0
            for parts, w, al in zip(wrapped, ws, aligns):
                yy = self.y - pad - sz
                self.c.setFont(fnt, sz)
                for p in parts:
                    if al == "right":
                        self.c.drawRightString(x + w - pad, yy, p)
                    elif al == "center":
                        self.c.drawCentredString(x + w / 2, yy, p)
                    else:
                        self.c.drawString(x + pad, yy, p)
                    yy -= sz * 1.22
                x += w
            self.y -= h
            return h

        if headers:
            draw_row(headers, is_header=True, fill=header_fill)
        for i, r in enumerate(rows):
            fill = LIGHT if (zebra and i % 2 == 1) else None
            draw_row(r, bold=(i in bold_rows), fill=fill)
            if i in rule_rows or (i + 1) in bold_rows:
                self.c.setStrokeColor(MID)
                self.c.setLineWidth(0.4)
                self.c.line(self.x0, self.y, self.x1, self.y)
                self.c.setStrokeColor(colors.black)
        self.c.setStrokeColor(MID)
        self.c.setLineWidth(0.4)
        self.c.line(self.x0, self.y, self.x1, self.y)
        self.c.setStrokeColor(colors.black)
        self.y -= 4

    def box(self, x, y, w, h, fill=None, stroke=MID):
        self.c.setStrokeColor(stroke)
        if fill is not None:
            self.c.setFillColor(fill)
        self.c.rect(x, y, w, h, stroke=1, fill=1 if fill is not None else 0)
        self.c.setFillColor(colors.black)
        self.c.setStrokeColor(colors.black)


__all__ = ["Doc", "fi", "en", "de", "fdate", "mm", "colors", "SYN", "GREY", "LIGHT", "MID", "A4"]
