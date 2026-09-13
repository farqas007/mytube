from PIL import Image, ImageDraw, ImageFont, ImageFilter

SIZE = 512

# Dark original background
img = Image.new("RGBA", (SIZE, SIZE), (15, 15, 22, 255))

# Glow layer
glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)

# Rounded-square glow
gd.rounded_rectangle(
    (55, 55, 457, 457),
    radius=95,
    fill=(255, 70, 180, 110)
)

glow = glow.filter(ImageFilter.GaussianBlur(35))
img = Image.alpha_composite(img, glow)

# Main rounded square
draw = ImageDraw.Draw(img)

draw.rounded_rectangle(
    (70, 70, 442, 442),
    radius=85,
    fill=(30, 24, 40, 255),
    outline=(255, 80, 190, 255),
    width=8
)

# "M" symbol
font_paths = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
]

font = None
for path in font_paths:
    try:
        font = ImageFont.truetype(path, 245)
        break
    except:
        pass

if font is None:
    raise RuntimeError("No suitable font found")

text = "M"
bbox = draw.textbbox((0, 0), text, font=font)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]

x = (SIZE - tw) // 2 - bbox[0]
y = (SIZE - th) // 2 - bbox[1] - 8

# M glow
text_glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
tg = ImageDraw.Draw(text_glow)
tg.text((x, y), text, font=font, fill=(255, 70, 190, 220))
text_glow = text_glow.filter(ImageFilter.GaussianBlur(18))
img = Image.alpha_composite(img, text_glow)

# Main M
draw = ImageDraw.Draw(img)
draw.text(
    (x, y),
    text,
    font=font,
    fill=(255, 255, 255, 255),
    stroke_width=3,
    stroke_fill=(255, 90, 195, 255)
)

# Small "MYTUBE" label
small_font = ImageFont.truetype(font_paths[0], 35)

label = "MYTUBE"
lb = draw.textbbox((0, 0), label, font=small_font)
lw = lb[2] - lb[0]

draw.text(
    ((SIZE - lw) // 2, 375),
    label,
    font=small_font,
    fill=(255, 120, 205, 255)
)

img.save("mytube-icon.png", "PNG")
print("Created: mytube-icon.png")
print("Size: 512x512")
