from PIL import Image, ImageDraw

S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
ink = (17, 17, 17, 255)

# microphone capsule
cap_w, cap_h = 150, 250
cx, cy = S // 2, 205
x0, y0 = cx - cap_w // 2, cy - cap_h // 2
d.rounded_rectangle([x0, y0, x0 + cap_w, y0 + cap_h], radius=75, fill=ink)
# grille dots
for gy in range(cy - 70, cy + 71, 34):
    for gx in range(cx - 45, cx + 46, 30):
        d.ellipse([gx - 7, gy - 7, gx + 7, gy + 7], fill=(255, 255, 255, 255))
# stand
d.arc([cx - 130, cy + 20, cx + 130, cy + 175], start=20, end=160, fill=ink, width=28)
d.rectangle([cx - 14, cy + 150, cx + 14, 430], fill=ink)
d.rounded_rectangle([cx - 95, 424, cx + 95, 460], radius=18, fill=ink)
# sound arcs
for r, wd in ((215, 16), (250, 14)):
    d.arc([cx - r, cy - r + 10, cx + r, cy + r + 10], start=-55, end=55, fill=ink, width=wd)
    d.arc([cx - r, cy - r + 10, cx + r, cy + r + 10], start=125, end=235, fill=ink, width=wd)

img.save("site/assets/logo.webp", "WEBP", quality=95, method=6)
print("logo.webp written", img.size)
